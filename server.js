const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// In-Memory user session state (Temporary storage for order flow)
const userSessions = {};

app.get('/', (req, res) => {
  res.send('🚀 ZUPZO WhatsApp Engine is Live!');
});

// 1. Instant Meta Handshake (Zero-delay, No Environment dependency)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === 'zupzo_secret_token_123') {
    console.log('Webhook verified successfully!');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});


// 2. Incoming WhatsApp Message Router
app.post('/webhook', async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0]?.value;
    const message = changes?.messages?.[0];

    if (!message) return res.sendStatus(200);

    const fromPhone = message.from; // Customer WhatsApp Number (e.g., 919876543210)
    const type = message.type;

    if (!userSessions[fromPhone]) {
      userSessions[fromPhone] = { step: 'IDLE', cart: [], selectedRestoId: null };
    }

    const session = userSessions[fromPhone];

    // Handle Button Clicks or Interactive List Selections
    if (type === 'interactive') {
      const interactiveType = message.interactive.type;
      let selectedId = '';

      if (interactiveType === 'button_reply') {
        selectedId = message.interactive.button_reply.id;
      } else if (interactiveType === 'list_reply') {
        selectedId = message.interactive.list_reply.id;
      }

      await handleInteractiveResponse(fromPhone, selectedId, session);
    } 
    // Handle Text Messages
    else if (type === 'text') {
      const text = message.text.body.trim();
      await handleTextMessage(fromPhone, text, session);
    } 
    // Handle GPS Pin Location
    else if (type === 'location') {
      const { latitude, longitude } = message.location;
      await sendTextMessage(fromPhone, `📍 Location pinned successfully! Fetching nearby active kitchens...`);
      await showOutletsList(fromPhone);
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('Webhook Error:', error.message);
    res.sendStatus(500);
  }
});

// Step-by-Step Message Logic
async function handleTextMessage(phone, text, session) {
  const lower = text.toLowerCase();

  if (lower === 'hi' || lower === 'hello' || lower === 'menu' || lower === 'order') {
    session.step = 'AWAITING_OUTLET';
    session.cart = [];
    await showOutletsList(phone);
  } 
  else if (session.step === 'AWAITING_ADDRESS') {
    // Save address and place order
    session.address = text;
    await finalizeWhatsAppOrder(phone, session);
  } 
  else {
    await sendTextMessage(
      phone,
      `Welcome to *ZUPZO Food Delivery*! 🛵\n\nTo view menu and place order, please reply with *Hi* or send your current *Location*.`
    );
  }
}

// Show Restaurants/Kitchens List
async function showOutletsList(phone) {
  const { data: restaurants } = await supabase
    .from('restaurants')
    .select('id, name')
    .eq('is_open', true)
    .limit(5);

  if (!restaurants || restaurants.length === 0) {
    await sendTextMessage(phone, 'Sorry, no active kitchens available in your zone right now.');
    return;
  }

  const rows = restaurants.map((r) => ({
    id: `RESTO_${r.id}`,
    title: r.name.slice(0, 24),
    description: 'Fast express delivery',
  }));

  const listPayload = {
    messaging_product: 'whatsapp',
    to: phone,
    type: 'interactive',
    interactive: {
      type: 'list',
      header: { type: 'text', text: 'Select Kitchen Outlet' },
      body: { text: 'Choose your preferred cloud kitchen to view available food items:' },
      footer: { text: 'ZUPZO Express' },
      action: {
        button: 'View Outlets',
        sections: [{ title: 'Available Outlets', rows: rows }],
      },
    },
  };

  await sendMetaRaw(listPayload);
}

// Show Items Menu for Selected Outlet
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
    await sendTextMessage(phone, 'No items currently in stock at this outlet.');
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
      body: { text: 'Tap an item to add it to your order tray:' },
      footer: { text: 'Tap multiple times for multiple items' },
      action: {
        button: 'Select Dish',
        sections: [{ title: 'Fresh Dishes', rows: rows }],
      },
    },
  };

  await sendMetaRaw(listPayload);
}

// Handle Interactive Button / List Click
async function handleInteractiveResponse(phone, actionId, session) {
  if (actionId.startsWith('RESTO_')) {
    const restoId = actionId.replace('RESTO_', '');
    await showOutletMenu(phone, restoId, session);
  } 
  else if (actionId.startsWith('ITEM_')) {
    const parts = actionId.split('_');
    const itemId = parts[1];
    const price = parseFloat(parts[2]);

    // Add item to cart
    session.cart.push({ itemId, price });

    const totalBill = session.cart.reduce((sum, i) => sum + i.price, 0);

    // Send Cart Summary with Checkout Button
    const buttonsPayload = {
      messaging_product: 'whatsapp',
      to: phone,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: {
          text: `✅ *Item Added!*\n\nCurrent Items in Cart: *${session.cart.length}*\nTotal Bill: *₹${totalBill}* (Excl. delivery)\n\nAdd more dishes or proceed to confirm:`,
        },
        action: {
          buttons: [
            {
              type: 'reply',
              reply: { id: `MORE_${session.selectedRestoId}`, title: '➕ Add More' },
            },
            {
              type: 'reply',
              reply: { id: 'CHECKOUT', title: '🛍️ Confirm Order' },
            },
          ],
        },
      },
    };

    await sendMetaRaw(buttonsPayload);
  } 
  else if (actionId.startsWith('MORE_')) {
    const restoId = actionId.replace('MORE_', '');
    await showOutletMenu(phone, restoId, session);
  } 
  else if (actionId === 'CHECKOUT') {
    if (session.cart.length === 0) {
      await sendTextMessage(phone, 'Your cart is empty! Reply with *Hi* to browse menu.');
      return;
    }
    session.step = 'AWAITING_ADDRESS';
    await sendTextMessage(
      phone,
      `🏠 *Delivery Address Needed:*\n\nPlease reply with your complete Address / Village name and nearby landmark (e.g., *House No 12, Main Road, Near Primary School*).`
    );
  }
}

// Finalize Order & Save to Supabase
async function finalizeWhatsAppOrder(phone, session) {
  const itemsTotal = session.cart.reduce((sum, i) => sum + i.price, 0);
  const deliveryFee = 25.0;
  const platformFee = 5.0;
  const grandTotal = itemsTotal + deliveryFee + platformFee;
  const otpPin = Math.floor(1000 + Math.random() * 9000).toString();
  const orderNumber = 'WA-' + Math.floor(100000 + Math.random() * 900000);

  // 1. Insert Core Order into Supabase
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
    await sendTextMessage(phone, 'Failed to place order. Please try again.');
    return;
  }

  // 2. Insert Items Breakdown
  const itemsPayload = session.cart.map((c) => ({
    order_id: newOrder.id,
    menu_item_id: c.itemId,
    quantity: 1,
    unit_price: c.price,
  }));
  await supabase.from('order_items').insert(itemsPayload);

  // 3. Reset Session
  delete userSessions[phone];

  // 4. Send Confirmation Message to Customer
  const confirmMsg =
    `🎉 *Order Confirmed!* (ID: #${orderNumber})\n\n` +
    `🍽️ *Items Total:* ₹${itemsTotal}\n` +
    `🛵 *Delivery Charge:* ₹${deliveryFee}\n` +
    `💵 *Total Amount:* ₹${grandTotal}\n` +
    `📍 *Address:* ${session.address}\n\n` +
    `🔐 *Your Delivery OTP:* *${otpPin}*\n` +
    `_(Please share this OTP with the delivery boy upon arrival)_\n\n` +
    `Kitchen has received your order. We will update you once it is dispatched! ⚡`;

  await sendTextMessage(phone, confirmMsg);
}

// Meta API Helpers
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
  if (!process.env.META_ACCESS_TOKEN || process.env.META_ACCESS_TOKEN === 'temp_token') {
    console.log('[LOCAL SIMULATION WA]', JSON.stringify(payload, null, 2));
    return;
  }

  try {
    await axios.post(
      `https://graph.facebook.com/v21.0/${process.env.META_PHONE_ID}/messages`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${process.env.META_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );
  } catch (err) {
    console.error('Meta API Dispatch Error:', err.response?.data || err.message);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ZUPZO Engine active on port ${PORT}`));
