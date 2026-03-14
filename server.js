const WebSocket = require('ws'); 
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

let userData = {
    token: null,
    userId: null,
    userName: null,
    isAutoAcceptActive: false,
    acceptedOrders: [],
    wsStatus: 'Disconnected'
};

let ws = null;
let pollingInterval = null; // Replaced by WS, but kept for fallback or status

// Helper to interact with PDC API
const pdcApi = axios.create({
    baseURL: 'https://riders.passodecuinar.cat/api',
    headers: {
        'User-Agent': 'Rider/1.4.4 (iPhone; iOS 16.6; Scale/3.00)'
    }
});

// LOGIN
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const response = await pdcApi.post('/login', { username, password });
        if (response.data && response.data.token) {
            userData.token = response.data.token;
            userData.userId = response.data.user.id;
            userData.userName = response.data.user.name;
            res.json({ success: true, user: response.data.user });
        } else {
            res.status(401).json({ success: false, message: 'Invalid response from PDC' });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: error.response?.data?.message || 'Login failed' });
    }
});

// STATUS
app.get('/api/status', (req, res) => {
    res.json(userData);
});

// TOGGLE AUTO-ACCEPT
app.post('/api/toggle', (req, res) => {
    userData.isAutoAcceptActive = req.body.active;
    
    if (userData.isAutoAcceptActive) {
        connectWebSocket();
    } else {
        disconnectWebSocket();
    }
    
    res.json({ success: true, active: userData.isAutoAcceptActive });
});

function connectWebSocket() {
    if (ws) return;
    
    const wsUrl = `wss://fewxk3rj0m.execute-api.eu-west-1.amazonaws.com/pro?token=${userData.token}`;
    console.log(`Connecting to WebSocket: ${wsUrl}`);
    userData.wsStatus = 'Connecting...';

    ws = new WebSocket(wsUrl, {
        headers: {
            'User-Agent': 'Rider/1.4.4 (iPhone; iOS 16.6; Scale/3.00)'
        }
    });

    ws.on('open', () => {
        console.log("WebSocket: CONNECTED to AWS Platform Refresh");
        userData.wsStatus = 'Connected (Real-Time)';
        
        // Some AWS API Gateways require an initial ping or subscription
        // We'll send a heartbeat to keep the connection alive
        const heartbeat = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ action: 'ping' }));
            }
        }, 30000);
        
        ws.heartbeat = heartbeat;
    });

    ws.on('message', async (data) => {
        const message = data.toString();
        console.log("WebSocket Message Received:", message);
        
        try {
            const payload = JSON.parse(message);
            // Check if the message contains "NEW_ORDER" or similar logic from the app
            if (message.includes('NEW_ORDER') || payload.type === 'order' || payload.action === 'new_order') {
                console.log("REAL-TIME ORDER DETECTED! Processing...");
                acceptNextOrder();
            }
        } catch (e) {
            // Handle non-JSON messages if any exist
        }
    });

    ws.on('close', () => {
        console.log("WebSocket: DISCONNECTED");
        userData.wsStatus = 'Disconnected';
        clearInterval(ws.heartbeat);
        ws = null;
        
        // Reconnect if auto-accept is still active
        if (userData.isAutoAcceptActive) {
            console.log("Attempting to reconnect in 5 seconds...");
            setTimeout(connectWebSocket, 5000);
        }
    });

    ws.on('error', (err) => {
        console.error("WebSocket Error:", err.message);
        userData.wsStatus = 'Error';
    });
}

function disconnectWebSocket() {
    if (ws) {
        ws.close();
        ws = null;
    }
    userData.wsStatus = 'Disconnected';
}

async function acceptNextOrder() {
    if (!userData.token || !userData.isAutoAcceptActive) return;
    
    try {
        // Fetch pending orders to get the ID
        const response = await pdcApi.get(`/users/${userData.userId}/orders/`, {
            headers: { 'Authorization': `Bearer ${userData.token}` }
        });
        
        const pendingOrders = response.data.filter(o => o.status === 'pending');
        
        if (pendingOrders.length > 0) {
            const order = pendingOrders[0]; // ONLY GET ONE
            
            console.log(`ONE-SHOT ACCEPTING: #${order.id}`);
            await pdcApi.post(`/users/${userData.userId}/orders/accept/`, 
                { order_id: order.id },
                { headers: { 'Authorization': `Bearer ${userData.token}` } }
            );
            
            userData.acceptedOrders.push({
                id: order.id,
                time: new Date().toLocaleTimeString(),
                status: 'Accepted (One-Shot Mode)'
            });

            // --- THE KILL SWITCH ---
            console.log("ONE ORDER SECURED. Deactivating for safety.");
            userData.isAutoAcceptActive = false;
            disconnectWebSocket(); // Turn off the listener automatically
        }
    } catch (error) {
        console.error("Accept Error:", error.message);
    }
}

app.listen(PORT, () => {
    console.log(`PDC Real-Time Dashboard running at http://localhost:${PORT}`);
});
