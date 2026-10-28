const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Initialize Supabase Client
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// 1. Health Check Route
app.get('/', (req, res) => {
  res.send('🚀 ZUPZO Engine is Running Live!');
});

// 2. WhatsApp Webhook Verification (Meta Handshake)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.META_VERIFY_TOKEN) {
    console.log('Webhook verified successfully!');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// 3. Incoming WhatsApp Messages & Location Handler
app.post('/webhook', async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0]?.value;
    const message = changes?.messages?.[0];

    if (!message) return res.sendStatus(200);

    const fromPhone = message.from; // Customer mobile number
    const type = message.type;

    if (type === 'text') {
      const text = message.text.body.trim().toLowerCase();
      // Welcome Message and Location Request
      await sendWhatsAppMessage(
        fromPhone,
        `Namaste! 🙏 Welcome to *ZUPZO Food Delivery*.\n\nKripya niche click karke apni *Location* share karein taaki hum aapke paas ke Best Restaurants dikha sakein.`
      );
    } else if (type === 'location') {
      const { latitude, longitude } = message.location;
      console.log(`Location received from ${fromPhone}: Lat ${latitude}, Lng ${longitude}`);

      // Fetch active restaurants from Supabase
      const { data: restaurants, error } = await supabase
        .from('restaurants')
        .select('id, name')
        .eq('is_open', true)
        .limit(1);

      if (restaurants && restaurants.length > 0) {
        const resto = restaurants[0];
        // Menu link bhejna
        await sendWhatsAppMessage(
          fromPhone,
          `📍 Location match ho gayi!\n\n🍔 *${resto.name}* aapke area me deliver kar raha hai.\n\n👇 Niche link se menu dekhein aur order karein:\nhttps://zupzo.vercel.app/menu?restoId=${resto.id}&phone=${fromPhone}`
        );
      } else {
        await sendWhatsAppMessage(
          fromPhone,
          'Maaf kijiye, abhi aapke area me ZUPZO service available nahi hai. Hum jaldi shuru karenge!'
        );
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook Error:', err.message);
    res.sendStatus(500);
  }
});

// Helper Function: Send WhatsApp Message via Meta Cloud API
async function sendWhatsAppMessage(toPhone, textBody) {
  if (!process.env.META_ACCESS_TOKEN || !process.env.META_PHONE_ID) {
    console.log(`[SIMULATION MODE] To: ${toPhone} | Message: ${textBody}`);
    return;
  }

  try {
    await axios.post(
      `https://graph.facebook.com/v21.0/${process.env.META_PHONE_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: toPhone,
        type: 'text',
        text: { body: textBody },
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.META_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );
  } catch (error) {
    console.error('Meta API Error:', error.response?.data || error.message);
  }
}

// 4. API to fetch Menu for Webview
app.get('/api/menu/:restaurantId', async (req, res) => {
  const { restaurantId } = req.params;
  const { data, error } = await supabase
    .from('menu_items')
    .select('*')
    .eq('restaurant_id', restaurantId)
    .eq('is_available', true);

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ items: data });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ZUPZO Server running on port ${PORT}`));
