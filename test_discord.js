const axios = require('axios');

const webhook = "https://discord.com/api/webhooks/1482195526693949724/TvbZ6bhsEN6tGbCNYlzsV6ejVZNvEwv2uFD0WKeTTeLJb5oht1BPXdaWWmGj0shOuzcK";

async function test() {
    try {
        await axios.post(webhook, {
            content: "🛠️ **NODE.JS TEST**: Testing Discord from the dashboard engine."
        });
        console.log("Success!");
    } catch (e) {
        console.error("Failed:", e.message);
    }
}

test();
