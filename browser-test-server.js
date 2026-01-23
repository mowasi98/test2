const express = require('express');
const browserBot = require('./discord-browser-bot');

const app = express();
app.use(express.json());

app.post('/submit-homework', async (req, res) => {
  const { productName, username, password, school, loginType, skipQueue } = req.body;
  console.log('📥 API Request received:', { productName, username, school, loginType, skipQueue: skipQueue || false });
  const result = await browserBot.submitToSparxNow(productName, username, password, school, loginType, skipQueue);
  res.json(result);
});

app.get('/status', (req, res) => {
  res.json(browserBot.getStatus());
});

app.post('/admin/reset-counter', (req, res) => {
  const result = browserBot.resetDailyCounter();
  res.json(result);
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

const PORT = 3001;
app.listen(PORT, async () => {
  console.log('Bot API ready on port ' + PORT);
  await browserBot.initBrowser();
});
