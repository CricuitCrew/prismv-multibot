const fs = require("fs");
const path = require("path");

const configPath = path.join(__dirname, "config.json");
if (!fs.existsSync(configPath)) {
  console.error("Manca config.json in bot01. Crea bots/bot01/config.json partendo da config.example.json");
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));

console.log(`[${config.botName}] Avvio...`);
console.log(`[${config.botName}] Token presente? ${config.token ? "SI" : "NO"}`);

// Qui poi mettiamo la logica Discord del Bot #1.
setInterval(() => {
  console.log(`[${config.botName}] vivo - ${new Date().toISOString()}`);
}, 30000);
