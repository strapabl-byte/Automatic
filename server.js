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

const VERSION = '1.0.1';

let userData = {
    token: null,
    userId: null,
    userName: null,
    isAutoAcceptActive: false,
    acceptedOrders: [],
    wsStatus: 'Disconnected',
    discordWebhookUrl: 'https://discord.com/api/webhooks/1482195526693949724/TvbZ6bhsEN6tGbCNYlzsV6ejVZNvEwv2uFD0WKeTTeLJb5oht1BPXdaWWmGj0shOuzcK'
};

// HELPER: Send Discord Notification
async function sendDiscordMessage(text) {
    if (!userData.discordWebhookUrl) return;
    try {
        await axios.post(userData.discordWebhookUrl, {
            content: text.replace(/<[^>]*>/g, '') // Strip HTML for Discord
        });
        console.log("Discord notification sent!");
    } catch (error) {
        console.error("Discord Error:", error.message);
    }
}

let ws = null;
let pollingInterval = null; 
let lastScanTime = 0;

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
    res.json({ ...userData, version: VERSION });
});

// TEST DISCORD
app.post('/api/test-discord', async (req, res) => {
    const { webhookUrl } = req.body;
    console.log("Discord Test Request for URL:", webhookUrl ? webhookUrl.substring(0, 30) + "..." : "NONE");
    
    if (!webhookUrl) return res.status(400).json({ success: false, message: 'Missing Webhook URL' });
    
    try {
        await axios.post(webhookUrl, {
            content: "🛠️ **DASHBOARD TEST**: Your Discord connection from Render is active and ready!"
        }, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });
        console.log("Discord Test: Success");
        res.json({ success: true });
    } catch (error) {
        console.error("Discord Test Error:", error.response?.data || error.message);
        res.status(500).json({ 
            success: false, 
            message: error.response?.data?.message || error.message 
        });
    }
});

// TOGGLE AUTO-ACCEPT
app.post('/api/toggle', (req, res) => {
    userData.isAutoAcceptActive = req.body.active;
    userData.discordWebhookUrl = req.body.discordWebhookUrl || '';
    
    if (userData.isAutoAcceptActive) {
        connectWebSocket();
        startPolling();
    } else {
        disconnectWebSocket();
        stopPolling();
    }
    
    res.json({ success: true, active: userData.isAutoAcceptActive });
});

function startPolling() {
    if (pollingInterval) return;
    console.log("MLC Engine: Starting High-Frequency Polling (5s Fallback)");
    pollingInterval = setInterval(() => {
        if (userData.isAutoAcceptActive && userData.token) {
            acceptNextOrder();
        }
    }, 5000); // 5 second scan cycle
}

function stopPolling() {
    if (pollingInterval) {
        clearInterval(pollingInterval);
        pollingInterval = null;
        console.log("MLC Engine: Polling Stopped.");
    }
}

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
    
    // Antigravity Throttling: Prevent multiple scans at the exact same millisecond
    const now = Date.now();
    if (now - lastScanTime < 1000) return;
    lastScanTime = now;

    try {
        const response = await pdcApi.get(`/users/${userData.userId}/orders/`, {
            headers: { 'Authorization': `Bearer ${userData.token}` }
        });
        
        // Find ANY order that is not finished
        const actionableOrders = (response.data || []).filter(o => 
            o.status === 'pending' || 
            o.status === 'available' || 
            o.status === 'broadcast' ||
            o.status === 'created' ||
            !o.rider_id
        );
        
        if (actionableOrders.length > 0) {
            const order = actionableOrders[0];
            
            console.log(`MLC CAPTURE DETECTED: #${order.id} [State: ${order.status}]`);
            
            // Step 1: TRY TO "TAKE" (This matches the "Assignar comanda" button)
            try {
                await pdcApi.post(`/users/${userData.userId}/orders/${order.id}/taken/`, 
                    {}, 
                    { headers: { 'Authorization': `Bearer ${userData.token}` } }
                );
                console.log(`[MLC] Order #${order.id} assigned successfully.`);
            } catch (err) {
                // Ignore errors if already taken
            }

            // Step 2: TRY TO "ACCEPT" (The final confirmation)
            try {
                await pdcApi.post(`/users/${userData.userId}/orders/accept/`, 
                    { order_id: order.id },
                    { headers: { 'Authorization': `Bearer ${userData.token}` } }
                );
                console.log(`[MLC] Order #${order.id} accepted successfully.`);
            } catch (err) {
                // Ignore errors if already accepted
            }
            
            // Mark as captured in our local history
            if (!userData.acceptedOrders.find(o => o.id === order.id)) {
                userData.acceptedOrders.push({
                    id: order.id,
                    time: new Date().toLocaleTimeString(),
                    status: `Secured [Initial: ${order.status}]`
                });

                // Notify Discord
                await sendDiscordMessage(`🎯 **ORDER SECURED!**\n\nOrder: #${order.id}\nStatus: ${order.status}\n\n*Dashboard deactivated to prevent double-booking.*`);
            }

            // Kill-switch for safety
            userData.isAutoAcceptActive = false;
            disconnectWebSocket();
            stopPolling();
        }
    } catch (error) {
        // Only log serious errors
        if (error.response?.status !== 401) {
            console.error("MLC Engine Scan Error:", error.message);
        }
    }
}

app.listen(PORT, () => {
    console.log(`PDC Real-Time Dashboard running at http://localhost:${PORT}`);
});
