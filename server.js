const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Supabase Connection
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// User Conversational Session State
const userSessions = {};

// 1. Healthcheck Route (To keep server warm)
app.get('/', (req, res) => {
  res.status(200).send('🚀 ZUPZO Production Engine is Live & Healthy!');
});

// 2. Strict Meta Webhook Handshake Verification (Plain Text Response)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  const expectedToken = process.env.META_VERIFY_TOKEN || 'zupzo_secret_token_123';

  if (mode === 'subscribe' && token === expectedToken) {
    console.log('✅ Meta Webhook Verified Successfully!');
    res.setHeader('Content-Type', 'text/plain');
    return res.status(200).send(challenge);
  }

  console.warn('❌ Webhook verification failed. Received token:', token);
  return res.sendStatus(403);
});

// 3. Incoming WhatsApp Webhook Router
app.post('/webhook', async (req, res) => {
  try {
    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0]?.value;
    const message = changes?.messages?.[0];

    // Meta demands a quick 200 OK acknowledgment immediately
    res.status(200).send('EVENT_RECEIVED');

    if (!message) return;

    const fromPhone = message.from;
    const type = message.type;

    if (!userSessions[fromPhone]) {
      userSessions[fromPhone] = { step: 'IDLE', cart: [], selectedRestoId: null };
    }

    const session = userSessions[fromPhone];

    if (type === 'interactive') {
      const interactiveType = message.interactive.type;
      let selectedId = '';

      if (interactiveType === 'button_reply') {
        selectedId = message.interactive.button_reply.id;
      } else if (interactiveType === 'list_reply') {
        selectedId = message.interactive.list_reply.id;
      }

      await handleInteractiveResponse(fromPhone, selectedId, session);
    } else if (type === 'text') {
      const text = message.text.body.trim();
      await handleTextMessage(fromPhone, text, session);
    } else if (type === 'location') {
      await sendTextMessage(fromPhone, '📍 Location received! Locating nearest cloud kitchens...');
      await showOutletsList(fromPhone);
    }
  } catch (error) {
    console.error('Error handling webhook event:', error.message);
  }
});

// Message Flow Controller
async function handleTextMessage(phone, text, session) {
  const lower = text.toLowerCase();

  if (lower === 'hi' || lower === 'hello' || lower === 'menu' || lower === 'order') {
    session.step = 'AWAITING_OUTLET';
    session.cart = [];
    await showOutletsList(phone);
  } else if (session.step === 'AWAITING_ADDRESS') {
    session.address = text;
    await finalizeWhatsAppOrder(phone, session);
  } else {
    await sendTextMessage(
      phone,
      'Welcome to *ZUPZO Food Delivery*! 🛵\n\nTo view restaurants and place an order, reply with *Hi* or share your current *Location*.'
    );
  }
}

// Show Restaurants
async function showOutletsList(phone) {
  const { data: restaurants } = await supabase
    .from('restaurants')
    .select('id, name')
    .eq('is_open', true)
    .limit(5);

  if (!restaurants || restaurants.length === 0) {
    await sendTextMessage(phone, 'Sorry, no active kitchens are operating right now.');
    return;
  }

  const rows = restaurants.map((r) => ({
    id: `RESTO_${r.id}`,
    title: r.name.slice(0, 24),
    description: 'Fresh Kitchen Partner',
  }));

  const listPayload = {
    messaging_product: 'whatsapp',
    to: phone,
    type: 'interactive',
    interactive: {
      type: 'list',
      header: { type: 'text', text: 'Select Kitchen' },
      body: { text: 'Choose your preferred kitchen outlet to explore available menu items:' },
      footer: { text: 'ZUPZO Express' },
      action: {
        button: 'View Outlets',
        sections: [{ title: 'Available Outlets', rows: rows }],
      },
    },
  };

  await sendMetaRaw(listPayload);
}

// Show Menu Items
async function showOutletMenu(phone, restoId, session) {
  session.selectedRestoId = restoId;
  session.step = 'SELECTING_ITEMS';

  const { data: items } = await supabase
    .from('menu_items')
    .select('id, name, price, is_veg')
    .eq('restaurant_id', restoId)
    .eq('is_available', true)
    .limit(8);

  if (!items || items.length === 0) {
    await sendTextMessage(phone, 'No items are in stock at this kitchen.');
    return;
  }

  const rows = items.map((i) => ({
    id: `ITEM_${i.id}_${i.price}`,
    title: `${i.is_veg ? '🟢' : '🔴'} ${i.name}`.slice(0, 24),
    description: `Price: ₹${i.price}`,
  }));

  const listPayload = {
    messaging_product: 'whatsapp',
    to: phone,
    type: 'interactive',
    interactive: {
      type: 'list',
      header: { type: 'text', text: 'ZUPZO Menu' },
      body: { text: 'Select a dish to add it to your order tray:' },
      footer: { text: 'Tap multiple dishes if desired' },
      action: {
        button: 'Select Dish',
        sections: [{ title: 'Fresh Dishes', rows: rows }],
      },
    },
  };

  await sendMetaRaw(listPayload);
}

// Interactive Responses
async function handleInteractiveResponse(phone, actionId, session) {
  if (actionId.startsWith('RESTO_')) {
    const restoId = actionId.replace('RESTO_', '');
    await showOutletMenu(phone, restoId, session);
  } else if (actionId.startsWith('ITEM_')) {
    const parts = actionId.split('_');
    const itemId = parts[1];
    const price = parseFloat(parts[2]);

    session.cart.push({ itemId, price });
    const totalBill = session.cart.reduce((sum, i) => sum + i.price, 0);

    const buttonsPayload = {
      messaging_product: 'whatsapp',
      to: phone,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: {
          text: `✅ *Item Added to Tray!*\n\nItems in Cart: *${session.cart.length}*\nSubtotal: *₹${totalBill}*\n\nAdd more items or confirm your order:`,
        },
        action: {
          buttons: [
            {
              type: 'reply',
              reply: { id: `MORE_${session.selectedRestoId}`, title: '➕ Add More' },
            },
            {
              type: 'reply',
              reply: { id: 'CHECKOUT', title: '🛍️ Checkout' },
            },
          ],
        },
      },
    };

    await sendMetaRaw(buttonsPayload);
  } else if (actionId.startsWith('MORE_')) {
    const restoId = actionId.replace('MORE_', '');
    await showOutletMenu(phone, restoId, session);
  } else if (actionId === 'CHECKOUT') {
    if (session.cart.length === 0) {
      await sendTextMessage(phone, 'Your tray is empty. Send *Hi* to browse again.');
      return;
    }
    session.step = 'AWAITING_ADDRESS';
    await sendTextMessage(
      phone,
      '🏠 *Delivery Address:*\n\nPlease reply with your complete Village name / colony and landmark (e.g., *Near High School, Main Gate*).'
    );
  }
}

// Final Order Execution
async function finalizeWhatsAppOrder(phone, session) {
  const itemsTotal = session.cart.reduce((sum, i) => sum + i.price, 0);
  const deliveryFee = 25.0;
  const platformFee = 5.0;
  const grandTotal = itemsTotal + deliveryFee + platformFee;
  const otpPin = Math.floor(1000 + Math.random() * 9000).toString();
  const orderNumber = 'WA-' + Math.floor(100000 + Math.random() * 900000);

  const { data: newOrder, error } = await supabase
    .from('orders')
    .insert([
      {
        order_number: orderNumber,
        restaurant_id: session.selectedRestoId,
        zone_id: 'a0000000-0000-0000-0000-000000000001',
        items_total: itemsTotal,
        delivery_fee: deliveryFee,
        platform_fee: platformFee,
        total_amount: grandTotal,
        order_status: 'ORDER_PLACED',
        payment_status: 'UNPAID',
        payment_mode: 'Cash / UPI on Delivery',
        delivery_address: `WhatsApp Order (${phone}) - ${session.address}`,
        delivery_otp: otpPin,
      },
    ])
    .select()
    .single();

  if (error) {
    console.error('Order creation error:', error);
    await sendTextMessage(phone, 'Sorry, failed to book your order. Please retry.');
    return;
  }

  const itemsPayload = session.cart.map((c) => ({
    order_id: newOrder.id,
    menu_item_id: c.itemId,
    quantity: 1,
    unit_price: c.price,
  }));
  await supabase.from('order_items').insert(itemsPayload);

  delete userSessions[phone];

  const confirmMsg =
    `🎉 *Order Confirmed!* (ID: #${orderNumber})\n\n` +
    `🍽️ *Food Total:* ₹${itemsTotal}\n` +
    `🛵 *Delivery Charge:* ₹${deliveryFee}\n` +
    `💵 *Payable Amount:* ₹${grandTotal}\n` +
    `📍 *Delivery Address:* ${session.address}\n\n` +
    `🔐 *Delivery Verification PIN:* *${otpPin}*\n` +
    `_(Provide this PIN to your delivery agent upon arrival)_\n\n` +
    `Our kitchen has commenced preparation. Thank you for choosing ZUPZO! ⚡`;

  await sendTextMessage(phone, confirmMsg);
}

// Outbound Message Senders
async function sendTextMessage(phone, text) {
  const payload = {
    messaging_product: 'whatsapp',
    to: phone,
    type: 'text',
    text: { body: text },
  };
  await sendMetaRaw(payload);
}

async function sendMetaRaw(payload) {
  const token = process.env.META_ACCESS_TOKEN;
  const phoneId = process.env.META_PHONE_ID;

  if (!token || token === 'temp_token') {
    console.log('[LOCAL DISPATCH SIMULATOR]', JSON.stringify(payload, null, 2));
    return;
  }

  try {
    await axios.post(
      `https://graph.facebook.com/v21.0/${phoneId}/messages`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      }
    );
  } catch (err) {
    console.error('Meta API Error:', err.response?.data || err.message);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ZUPZO Backend Server running on port ${PORT}`));
