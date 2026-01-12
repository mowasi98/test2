require('dotenv').config();
const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { Resend } = require('resend');
const mongoose = require('mongoose');

const app = express();
app.use(cors());

// ⚠️ IMPORTANT: Stripe webhook endpoint MUST come BEFORE express.json()
// Stripe needs the raw body to verify webhook signatures
app.post('/stripe-webhook', express.raw({type: 'application/json'}), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  
  if (!webhookSecret) {
    console.error('❌ STRIPE_WEBHOOK_SECRET not set in environment variables');
    return res.status(500).send('Webhook secret not configured');
  }
  
  let event;
  
  try {
    // Verify webhook signature
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    console.log('✅ Webhook signature verified:', event.type);
  } catch (err) {
    console.error('❌ Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  
  // Handle the checkout.session.completed event
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    console.log('💳 WEBHOOK: Payment completed for session:', session.id);
    
    // Extract metadata we attached during checkout session creation
    const metadata = session.metadata || {};
    const { reservationId, school, username, password, productName: rawProductName, productPrice, previousUsername } = metadata;
    
    // Clean product name (remove " - Extra Slot" suffix for backend processing)
    const productName = rawProductName ? rawProductName.replace(' - Extra Slot', '').trim() : '';
    const isExtraSlot = rawProductName && rawProductName.includes(' - Extra Slot');
    
    console.log('💳 WEBHOOK: Extracted metadata:', {
      reservationId,
      school,
      username,
      productName,
      rawProductName,
      isExtraSlot,
      productPrice,
      previousUsername,
      hasPassword: !!password
    });
    
    // Check if this is a new login
    const isNewLogin = !previousUsername || previousUsername !== username;
    
    // Process the purchase (same logic as /submit-login-details)
    try {
      // Check if product is available
      resetDailyCountersIfNeeded();
      if (productName && dailyLimits[productName] && !dailyLimits[productName].available) {
        console.error(`❌ WEBHOOK: Product "${productName}" is not available`);
        return res.json({ received: true, warning: 'Product not available' });
      }
      
      // Confirm reservation and get slot status
      let remainingSlots = 0;
      let currentCount = 0;
      let maxSlots = MAX_PURCHASES_PER_DAY;
      
      if (productName && dailyLimits[productName]) {
        // Determine if this is an extra slot purchase
        if (isExtraSlot && productName === 'Sparx Reader' && dailyLimits[productName].extraSlots) {
          // Extra slot purchase - show extra slot info
          currentCount = dailyLimits[productName].extraSlots.count;
          maxSlots = dailyLimits[productName].extraSlots.max;
          remainingSlots = Math.max(0, maxSlots - currentCount);
        } else {
          // Regular slot purchase
          currentCount = dailyLimits[productName].count;
          maxSlots = MAX_PURCHASES_PER_DAY;
          remainingSlots = Math.max(0, maxSlots - currentCount);
        }
        
        // Confirm the reservation
        if (reservationId && activeReservations[reservationId]) {
          if (activeReservations[reservationId].productName === productName) {
            delete activeReservations[reservationId];
            const slotType = activeReservations[reservationId].isExtraSlot ? 'EXTRA SLOT' : 'regular slot';
            console.log(`✅ WEBHOOK: Reservation CONFIRMED (${slotType}) for "${productName}" - ID: ${reservationId}`);
          } else {
            console.warn(`⚠️ WEBHOOK: Reservation ID mismatch, confirming all for ${productName}`);
            confirmReservation(productName);
          }
        } else {
          console.log(`✅ WEBHOOK: Confirming all reservations for "${productName}"`);
          confirmReservation(productName);
        }
        
        console.log(`✅ WEBHOOK: Product "${productName}" ${isExtraSlot ? 'extra slots' : 'regular slots'}: ${currentCount}/${maxSlots} (${remainingSlots} remaining)`);
      }
      
      // Send email notification
      if (username && password && productName) {
        console.log(`📧 WEBHOOK: Sending card payment email for ${isExtraSlot ? 'EXTRA SLOT' : 'regular slot'}...`);
        await sendLoginDetailsNotification({
          school: school || 'Not provided',
          username,
          password,
          platform: rawProductName || productName, // Use raw name for display (includes "- Extra Slot")
          sessionId: session.id,
          productName: rawProductName || productName, // Use raw name for display
          productPrice,
          paymentMethod: 'card',
          remainingSlots,
          currentCount,
          maxSlots,
          isExtraSlot: isExtraSlot || false,
          isNewLogin
        });
        console.log('✅ WEBHOOK: Email sent successfully');
      }
      
      // Track login history
      loginHistory.push({
        username,
        school: school || 'Not provided',
        productName: rawProductName || productName || 'Unknown', // Use raw name for display
        productPrice: productPrice || 'Unknown',
        paymentMethod: 'Card (Webhook)',
        timestamp: new Date().toISOString(),
        isNewLogin
      });
      console.log(`📊 WEBHOOK: Login tracked: ${username} (Total: ${loginHistory.length})`);
      
      // Update active session
      if (username && activeSessions[username]) {
        activeSessions[username].lastActive = Date.now();
      }
      
      // Save to MongoDB
      await saveData();
      console.log('✅ WEBHOOK: Purchase processed successfully');
      
    } catch (error) {
      console.error('❌ WEBHOOK: Error processing purchase:', error);
    }
  }
  
  // Return 200 to acknowledge receipt
  res.json({ received: true });
});

// NOW apply express.json() for all other routes
app.use(express.json());

// MongoDB Connection
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/hwplug';
console.log('🔌 Connecting to MongoDB...');

mongoose.connect(MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => {
  console.log('✅ MongoDB connected successfully');
}).catch(err => {
  console.error('❌ MongoDB connection error:', err);
  console.error('⚠️  Server will continue with in-memory storage (data will not persist)');
});

// MongoDB Schema for persistent data
const DataSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  dailyLimits: { type: Object, default: {} },
  activeReservations: { type: Object, default: {} },
  lastTimerResetTime: { type: Number, default: Date.now },
  loginHistory: { type: Array, default: [] },
  cashPaymentCodes: { type: Array, default: [] }, // Array of valid codes for cash payments
  codeUsageHistory: { type: Array, default: [] }, // Track who used which codes
  availabilitySchedule: { type: Object, default: {} }, // Availability timing configuration
  bannedUsers: { type: Array, default: [] }, // List of banned users
  testMode: { type: Boolean, default: false }, // Test mode flag
  whitelistMode: { type: Boolean, default: false }, // Whitelist mode - only approved users can access
  whitelistedUsers: { type: Array, default: [] }, // List of approved usernames
  updatedAt: { type: Date, default: Date.now }
});

const DataModel = mongoose.model('Data', DataSchema);

// Daily purchase limit tracking (3 per product per day)
let dailyLimits = {
  'Sparx Reader': { count: 0, date: null, available: true, extraSlots: { count: 0, max: 2 } },
  'Sparx Maths': { count: 0, date: null, available: true },
  'Educate': { count: 0, date: null, available: true },
  'Seneca': { count: 0, date: null, available: true }
};

// Test mode flag - when enabled, shows "Come back later" screen to all users
let testMode = false;

// Whitelist mode - when enabled, only approved users can access the website
let whitelistMode = false;
let whitelistedUsers = []; // Array of approved usernames

const MAX_PURCHASES_PER_DAY = 3; // Default starting slots per product per day
const ADMIN_MAX_SLOTS = 20; // Maximum slots admin can set per product
const EXTRA_SLOT_PRICE = 3; // £3 total for extra slots (when regular slots are full)
const EXTRA_SLOT_MAX = 2; // Maximum 2 extra slots for Sparx Reader
const RESERVATION_TIMEOUT = 30 * 60 * 1000; // 30 minutes in milliseconds (increased for Stripe payment flow)

// Track active reservations: { reservationId: { productName, timestamp } }
let activeReservations = {};

// Store the last timer reset time (for frontend to sync) - Initialize with current time
let lastTimerResetTime = Date.now();

// Track all login history
let loginHistory = [];

// Track active sessions: { username: { lastActive: timestamp, school: '' } }
let activeSessions = {};
const SESSION_TIMEOUT = 2 * 60 * 1000; // 2 minutes of inactivity = offline

// Cash payment codes (admin can add/remove)
let cashPaymentCodes = [];

// Track code usage: { code, username, school, productName, timestamp }
let codeUsageHistory = [];

// Banned users list: { username, reason, bannedAt, bannedBy }
let bannedUsers = [];

// Availability Schedule Configuration
let availabilitySchedule = {
  weekday: { // Monday to Friday
    enabled: true,
    startTime: '15:30', // 3:30 PM
    endTime: '00:00' // 12:00 AM (midnight)
  },
  weekend: { // Saturday and Sunday
    enabled: true,
    allDay: true // 24/7
  }
};

// Check if products are currently available based on schedule
function checkAvailability() {
  const now = new Date();
  const dayOfWeek = now.getDay(); // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
  const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6); // Sunday or Saturday
  
  // Get current time in HH:MM format
  const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  
  if (isWeekend) {
    // Weekend: Check if allDay is enabled
    if (availabilitySchedule.weekend.enabled && availabilitySchedule.weekend.allDay) {
      return { 
        available: true,
        message: 'Products available 24/7 on weekends',
        nextAvailableTime: null
      };
    } else {
      return {
        available: false,
        message: 'Products not available on weekends',
        nextAvailableTime: 'Monday at 3:30 PM'
      };
    }
  } else {
    // Weekday (Monday-Friday)
    if (!availabilitySchedule.weekday.enabled) {
      return {
        available: false,
        message: 'Products not available on weekdays',
        nextAvailableTime: 'Saturday (24/7)'
      };
    }
    
    const startTime = availabilitySchedule.weekday.startTime;
    const endTime = availabilitySchedule.weekday.endTime;
    
    // Handle midnight crossing (e.g., 15:30 to 00:00)
    if (endTime === '00:00' || endTime < startTime) {
      // If current time is after start time OR before end time (next day)
      if (currentTime >= startTime || currentTime < endTime) {
        return {
          available: true,
          message: `Products available until midnight`,
          nextAvailableTime: null
        };
      } else {
        return {
          available: false,
          message: `Products available from 3:30 PM to 12:00 AM`,
          nextAvailableTime: '3:30 PM today'
        };
      }
    } else {
      // Normal time range (no midnight crossing)
      if (currentTime >= startTime && currentTime <= endTime) {
        return {
          available: true,
          message: `Products available until ${endTime}`,
          nextAvailableTime: null
        };
      } else if (currentTime < startTime) {
        return {
          available: false,
          message: `Products available from 3:30 PM to 12:00 AM`,
          nextAvailableTime: '3:30 PM today'
        };
      } else {
        return {
          available: false,
          message: `Products available from 3:30 PM to 12:00 AM`,
          nextAvailableTime: '3:30 PM tomorrow'
        };
      }
    }
  }
}

// ====== MONGODB PERSISTENT STORAGE FUNCTIONS ======

// Save data to MongoDB (async, non-blocking)
async function saveData() {
  try {
    if (mongoose.connection.readyState !== 1) {
      console.log('⚠️  MongoDB not connected, skipping save');
      return;
    }
    
    await DataModel.findOneAndUpdate(
      { key: 'main' },
      {
        key: 'main',
      dailyLimits,
      activeReservations,
      lastTimerResetTime,
      loginHistory,
      cashPaymentCodes,
      codeUsageHistory,
      availabilitySchedule,
      bannedUsers,
      testMode,
      whitelistMode,
      whitelistedUsers,
      updatedAt: new Date()
      },
      { upsert: true, new: true }
    );
    
    console.log('💾 Data saved to MongoDB');
  } catch (error) {
    console.error('❌ Error saving data to MongoDB:', error.message);
  }
}

// Load data from MongoDB
async function loadData() {
  try {
    if (mongoose.connection.readyState !== 1) {
      console.log('⚠️  MongoDB not connected, using default data');
      return;
    }
    
    const data = await DataModel.findOne({ key: 'main' });
    
    if (data) {
      // Restore data
      const loadedLimits = data.dailyLimits || dailyLimits;
      
      // Merge loaded data with default structure to ensure extraSlots is always present
      dailyLimits = {
        'Sparx Reader': {
          ...dailyLimits['Sparx Reader'],
          ...loadedLimits['Sparx Reader'],
          extraSlots: loadedLimits['Sparx Reader']?.extraSlots || { count: 0, max: 2 }
        },
        'Sparx Maths': loadedLimits['Sparx Maths'] || dailyLimits['Sparx Maths'],
        'Educate': loadedLimits['Educate'] || dailyLimits['Educate'],
        'Seneca': loadedLimits['Seneca'] || dailyLimits['Seneca']
      };
      
      activeReservations = data.activeReservations || {};
      lastTimerResetTime = data.lastTimerResetTime || Date.now();
      loginHistory.push(...(data.loginHistory || []));
      cashPaymentCodes = data.cashPaymentCodes || [];
      codeUsageHistory = data.codeUsageHistory || [];
      availabilitySchedule = data.availabilitySchedule || availabilitySchedule;
      bannedUsers = data.bannedUsers || [];
      testMode = data.testMode || false;
      whitelistMode = data.whitelistMode || false;
      whitelistedUsers = data.whitelistedUsers || [];
      
      console.log('✅ Data loaded from MongoDB');
      console.log(`   - Last updated: ${data.updatedAt}`);
      console.log(`   - Login history entries: ${loginHistory.length}`);
      console.log(`   - Active reservations: ${Object.keys(activeReservations).length}`);
      console.log(`   - Cash payment codes: ${cashPaymentCodes.length}`);
      console.log(`   - Code usage history: ${codeUsageHistory.length}`);
      console.log(`   - Availability schedule:`, availabilitySchedule);
      console.log(`   - Whitelist mode: ${whitelistMode ? 'ENABLED' : 'disabled'} (${whitelistedUsers.length} users)`);
      console.log(`   - Slot counts:`, Object.entries(dailyLimits).map(([k, v]) => `${k}: ${v.count}${k === 'Sparx Reader' && v.extraSlots ? ` (extra: ${v.extraSlots.count}/${v.extraSlots.max})` : ''}`).join(', '));
    } else {
      console.log('📝 No saved data found in MongoDB, starting fresh');
      await saveData(); // Create initial document
    }
  } catch (error) {
    console.error('❌ Error loading data from MongoDB:', error.message);
  }
}

// Load data on startup (after MongoDB connects)
mongoose.connection.once('open', async () => {
  await loadData();
});

  // Clean up expired reservations (run every minute)
setInterval(() => {
  const now = Date.now();
  let hasChanges = false;
  Object.keys(activeReservations).forEach(reservationId => {
    const reservation = activeReservations[reservationId];
    const age = now - reservation.timestamp;
    if (age > RESERVATION_TIMEOUT) {
      // Release expired reservation
      if (dailyLimits[reservation.productName] && dailyLimits[reservation.productName].count > 0) {
        const oldCount = dailyLimits[reservation.productName].count;
        dailyLimits[reservation.productName].count--;
        const newCount = dailyLimits[reservation.productName].count;
        console.log(`⏰ Expired reservation released for "${reservation.productName}": ${oldCount} → ${newCount} (ID: ${reservationId}, age: ${Math.round(age / 60000)} min)`);
        hasChanges = true;
      } else {
        console.log(`⏰ Expired reservation for "${reservation.productName}" but count already at 0 (ID: ${reservationId}, age: ${Math.round(age / 60000)} min)`);
      }
      delete activeReservations[reservationId];
      hasChanges = true;
    }
  });
  if (hasChanges) {
    saveData();
  }
}, 60000); // Check every minute

// Clean up inactive sessions (run every minute)
setInterval(() => {
  const now = Date.now();
  Object.keys(activeSessions).forEach(username => {
    const session = activeSessions[username];
    const inactiveTime = now - session.lastActive;
    if (inactiveTime > SESSION_TIMEOUT) {
      console.log(`👋 User "${username}" is now inactive (${Math.round(inactiveTime / 60000)} min)`);
      delete activeSessions[username];
    }
  });
}, 60000); // Check every minute

// Reset counters if it's a new day
function resetDailyCountersIfNeeded() {
  const today = new Date().toDateString();
  let hasChanges = false;
  Object.keys(dailyLimits).forEach(product => {
    if (dailyLimits[product].date !== today) {
      // Only reset slots for products that are currently AVAILABLE
      if (dailyLimits[product].available) {
        dailyLimits[product].count = 0;
        dailyLimits[product].date = today;
        
        // Reset extra slots for Sparx Reader
        if (product === 'Sparx Reader' && dailyLimits[product].extraSlots) {
          dailyLimits[product].extraSlots.count = 0;
          console.log(`✅ Extra slots also reset for "${product}"`);
        }
        
        hasChanges = true;
        console.log(`✅ Slots reset for AVAILABLE product: "${product}" (0/${MAX_PURCHASES_PER_DAY})`);
      } else {
        // Product is disabled - just update the date but DON'T reset count
        dailyLimits[product].date = today;
        console.log(`⏭️ Product "${product}" is DISABLED - slots NOT reset (keeping ${dailyLimits[product].count}/${MAX_PURCHASES_PER_DAY})`);
      }
    }
  });
  if (hasChanges) {
    console.log('🔄 Daily counters reset (new day) - only for available products');
    saveData();
  }
}

// Check product availability endpoint
app.get('/check-product-availability', (req, res) => {
  resetDailyCountersIfNeeded();
  const productName = req.query.product;
  
  if (!productName || !dailyLimits[productName]) {
    return res.json({ available: false, error: 'Product not found' });
  }
  
  const product = dailyLimits[productName];
  
  // Check if product is manually set as unavailable
  if (!product.available) {
    return res.json({
      available: false,
      remaining: 0,
      count: product.count,
      max: MAX_PURCHASES_PER_DAY,
      manuallyDisabled: true,
      extraSlots: productName === 'Sparx Reader' ? product.extraSlots : null
    });
  }
  
  // Check if regular slots are full
  const regularAvailable = product.count < MAX_PURCHASES_PER_DAY;
  const remaining = Math.max(0, MAX_PURCHASES_PER_DAY - product.count);
  
  // For Sparx Reader, check extra slots availability
  let extraSlotsInfo = null;
  if (productName === 'Sparx Reader' && product.extraSlots) {
    const extraSlotsAvailable = !regularAvailable && product.extraSlots.count < product.extraSlots.max;
    extraSlotsInfo = {
      available: extraSlotsAvailable,
      count: product.extraSlots.count,
      max: product.extraSlots.max,
      price: EXTRA_SLOT_PRICE
    };
  }
  
  res.json({
    available: regularAvailable,
    remaining: remaining,
    count: product.count,
    max: MAX_PURCHASES_PER_DAY,
    manuallyDisabled: false,
    extraSlots: extraSlotsInfo
  });
});

// Reserve a slot (atomically check and increment) - prevents race conditions
app.post('/reserve-slot', (req, res) => {
  resetDailyCountersIfNeeded();
  const { productName, isExtraSlot } = req.body;
  
  if (!productName || !dailyLimits[productName]) {
    return res.status(400).json({ success: false, error: 'Product not found' });
  }
  
  const product = dailyLimits[productName];
  
  // Check if product is manually disabled
  if (!product.available) {
    return res.json({ 
      success: false, 
      error: 'Product is not available right now',
      manuallyDisabled: true
    });
  }
  
  // Check if test mode is active (block purchases unless user is whitelisted)
  if (testMode) {
    // Test mode is active - user must be whitelisted
    // Note: Frontend should have already checked, but this is a backend safety check
    console.log('⚠️ Test mode active - blocking reservation attempt');
    return res.json({
      success: false,
      error: 'Website is in test mode. Please refresh the page.',
      testMode: true
    });
  }
  
  // Check availability schedule (time-based)
  const availabilityStatus = checkAvailability();
  if (!availabilityStatus.available) {
    return res.json({
      success: false,
      error: availabilityStatus.message,
      nextAvailableTime: availabilityStatus.nextAvailableTime,
      timeRestricted: true
    });
  }
  
  // Handle EXTRA SLOT for Sparx Reader
  if (isExtraSlot && productName === 'Sparx Reader') {
    // Check if regular slots are full
    if (product.count < MAX_PURCHASES_PER_DAY) {
      return res.json({
        success: false,
        error: 'Regular slots are still available. Extra slots only available when regular slots are full.'
      });
    }
    
    // Check if extra slots are available
    if (!product.extraSlots || product.extraSlots.count >= product.extraSlots.max) {
      return res.json({
        success: false,
        error: 'Extra slots are finished for today',
        extraSlotsFull: true
      });
    }
    
    // Reserve extra slot
    const oldExtraCount = product.extraSlots.count;
    product.extraSlots.count++;
    const extraRemaining = product.extraSlots.max - product.extraSlots.count;
    
    const reservationId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    activeReservations[reservationId] = {
      productName: productName,
      timestamp: Date.now(),
      isExtraSlot: true
    };
    
    console.log(`💎 EXTRA SLOT RESERVED for "${productName}": ${oldExtraCount} → ${product.extraSlots.count}/${product.extraSlots.max} (${extraRemaining} remaining) - Reservation ID: ${reservationId}`);
    
    saveData();
    
    return res.json({
      success: true,
      reserved: true,
      reservationId: reservationId,
      isExtraSlot: true,
      extraSlotCount: product.extraSlots.count,
      extraSlotMax: product.extraSlots.max,
      extraSlotPrice: EXTRA_SLOT_PRICE,
      wasLastExtraSlot: extraRemaining === 0
    });
  }
  
  // REGULAR SLOT RESERVATION
  // ATOMIC check and increment (prevents race condition)
  if (product.count >= MAX_PURCHASES_PER_DAY) {
    // Check if this is Sparx Reader with extra slots available
    if (productName === 'Sparx Reader' && product.extraSlots && product.extraSlots.count < product.extraSlots.max) {
      return res.json({ 
        success: false, 
        error: 'Regular slots are finished',
        remaining: 0,
        count: product.count,
        extraSlotsAvailable: true,
        extraSlotPrice: EXTRA_SLOT_PRICE
      });
    }
    
    return res.json({ 
      success: false, 
      error: 'Slots are finished for today',
      remaining: 0,
      count: product.count
    });
  }
  
  // CRITICAL: Increment IMMEDIATELY before any other operation
  const oldCount = product.count;
  product.count++;
  const remaining = MAX_PURCHASES_PER_DAY - product.count;
  
  // Create reservation ID and track it
  const reservationId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  activeReservations[reservationId] = {
    productName: productName,
    timestamp: Date.now(),
    isExtraSlot: false
  };
  
  const wasLastSlot = remaining === 0;
  console.log(`🔒 Slot RESERVED for "${productName}": ${oldCount} → ${product.count}/${MAX_PURCHASES_PER_DAY} (${remaining} remaining)${wasLastSlot ? ' ⚠️ LAST SLOT!' : ''} - Reservation ID: ${reservationId} (timeout: ${RESERVATION_TIMEOUT / 60000} min)`);
  
  // Save to disk immediately
  saveData();
  
  res.json({
    success: true,
    reserved: true,
    reservationId: reservationId,
    count: product.count,
    remaining: remaining,
    max: MAX_PURCHASES_PER_DAY,
    wasLastSlot: wasLastSlot,
    isExtraSlot: false
  });
});

// Release a reserved slot (if user abandons payment)
app.post('/release-slot', (req, res) => {
  resetDailyCountersIfNeeded();
  const { reservationId, productName } = req.body;
  
  if (!reservationId || !productName) {
    return res.status(400).json({ success: false, error: 'Reservation ID and product name required' });
  }
  
  // Check if reservation exists
  if (!activeReservations[reservationId]) {
    return res.json({ 
      success: false, 
      error: 'Reservation not found or already released',
      message: 'Slot may have already been released or expired'
    });
  }
  
  const reservation = activeReservations[reservationId];
  
  // Verify product matches
  if (reservation.productName !== productName) {
    return res.status(400).json({ success: false, error: 'Product name mismatch' });
  }
  
  // Check if this was an extra slot reservation
  if (reservation.isExtraSlot && productName === 'Sparx Reader') {
    // Release extra slot
    if (dailyLimits[productName].extraSlots && dailyLimits[productName].extraSlots.count > 0) {
      dailyLimits[productName].extraSlots.count--;
      const extraRemaining = dailyLimits[productName].extraSlots.max - dailyLimits[productName].extraSlots.count;
      
      delete activeReservations[reservationId];
      console.log(`🔓 EXTRA SLOT RELEASED for "${productName}": ${dailyLimits[productName].extraSlots.count}/${dailyLimits[productName].extraSlots.max} - Reservation ID: ${reservationId}`);
      
      saveData();
      
      return res.json({
        success: true,
        released: true,
        isExtraSlot: true,
        extraSlotCount: dailyLimits[productName].extraSlots.count,
        extraSlotMax: dailyLimits[productName].extraSlots.max
      });
    }
  }
  
  // Release regular slot by decrementing
  if (dailyLimits[productName] && dailyLimits[productName].count > 0) {
    dailyLimits[productName].count--;
    const remaining = MAX_PURCHASES_PER_DAY - dailyLimits[productName].count;
    
    // Remove reservation
    delete activeReservations[reservationId];
    
    console.log(`🔓 Slot RELEASED for "${productName}": ${dailyLimits[productName].count}/${MAX_PURCHASES_PER_DAY} (${remaining} remaining) - Reservation ID: ${reservationId}`);
    
    // Save to disk
    saveData();
    
    res.json({
      success: true,
      released: true,
      count: dailyLimits[productName].count,
      remaining: remaining,
      max: MAX_PURCHASES_PER_DAY,
      isExtraSlot: false
    });
  } else {
    // Already released or count is 0
    delete activeReservations[reservationId];
    saveData();
    res.json({
      success: false,
      error: 'Slot was already released',
      count: dailyLimits[productName] ? dailyLimits[productName].count : 0
    });
  }
});

// Increment product purchase count (kept for backward compatibility)
app.post('/increment-product-count', (req, res) => {
  resetDailyCountersIfNeeded();
  const { productName } = req.body;
  
  if (!productName || !dailyLimits[productName]) {
    return res.status(400).json({ error: 'Product not found' });
  }
  
  if (dailyLimits[productName].count >= MAX_PURCHASES_PER_DAY) {
    return res.status(400).json({ error: 'Daily limit reached for this product' });
  }
  
  dailyLimits[productName].count++;
  res.json({
    success: true,
    count: dailyLimits[productName].count,
    remaining: MAX_PURCHASES_PER_DAY - dailyLimits[productName].count
  });
});

// Admin endpoint to reset all counters
app.post('/admin/reset-counters', (req, res) => {
  const { password } = req.body;
  // Simple password protection (you can change this password)
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'hwplug2025';
  
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  // Clear all active reservations when resetting counters
  const clearedReservations = Object.keys(activeReservations).length;
  Object.keys(activeReservations).forEach(reservationId => {
    delete activeReservations[reservationId];
  });
  
  Object.keys(dailyLimits).forEach(product => {
    dailyLimits[product].count = 0;
    dailyLimits[product].date = new Date().toDateString();
    
    // Reset extra slots for Sparx Reader
    if (product === 'Sparx Reader' && dailyLimits[product].extraSlots) {
      dailyLimits[product].extraSlots.count = 0;
      console.log(`✅ Extra slots also reset for "${product}"`);
    }
  });
  
  console.log(`🔄 Admin reset: All counters reset to 0, cleared ${clearedReservations} active reservations`);
  
  // Save to disk
  saveData();
  
  res.json({
    success: true,
    message: 'All counters reset successfully',
    counters: dailyLimits,
    clearedReservations: clearedReservations
  });
});

// Admin endpoint to reset individual product counter
app.post('/admin/reset-product-counter', (req, res) => {
  const { password, productName } = req.body;
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'hwplug2025';
  
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  if (!productName || !dailyLimits[productName]) {
    return res.status(400).json({ error: 'Product not found' });
  }
  
  // Clear active reservations for this product when resetting
  let clearedReservations = 0;
  Object.keys(activeReservations).forEach(reservationId => {
    if (activeReservations[reservationId].productName === productName) {
      delete activeReservations[reservationId];
      clearedReservations++;
    }
  });
  
  dailyLimits[productName].count = 0;
  dailyLimits[productName].date = new Date().toDateString();
  
  // Also reset extra slots for Sparx Reader
  if (productName === 'Sparx Reader' && dailyLimits[productName].extraSlots) {
    dailyLimits[productName].extraSlots.count = 0;
    console.log(`✅ Extra slots also reset for "${productName}"`);
  }
  
  console.log(`🔄 Admin reset: Product "${productName}" counter reset to 0, cleared ${clearedReservations} active reservations`);
  
  // Save to disk
  saveData();
  
  res.json({
    success: true,
    message: `Counter reset for ${productName}`,
    product: productName,
    counter: dailyLimits[productName],
    clearedReservations: clearedReservations
  });
});

// Admin endpoint to set product availability (all products)
app.post('/admin/set-product-availability', (req, res) => {
  const { password, available } = req.body;
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'hwplug2025';
  
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  // Update all products availability
  Object.keys(dailyLimits).forEach(product => {
    dailyLimits[product].available = available === true;
  });
  
  // Save to disk
  saveData();
  
  res.json({
    success: true,
    message: `All products ${available ? 'marked as available' : 'marked as not available'}`,
    availability: available
  });
});

// Admin endpoint to toggle individual product availability
app.post('/admin/toggle-product-availability', (req, res) => {
  const { password, productName, available } = req.body;
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'hwplug2025';
  
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  if (!productName || !dailyLimits[productName]) {
    return res.status(400).json({ error: 'Product not found' });
  }
  
  // Toggle individual product availability
  dailyLimits[productName].available = available === true;
  
  // Save to disk
  saveData();
  
  res.json({
    success: true,
    message: `${productName} ${available ? 'marked as available' : 'marked as not available'}`,
    product: productName,
    availability: available
  });
});

// Admin endpoint to set custom slot count for a product
app.post('/admin/set-slot-count', (req, res) => {
  const { password, productName, slotCount } = req.body;
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'hwplug2025';
  
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  if (!productName || !dailyLimits[productName]) {
    return res.status(400).json({ error: 'Product not found' });
  }
  
  // Validate slot count
  const newCount = parseInt(slotCount);
  if (isNaN(newCount) || newCount < 0) {
    return res.status(400).json({ error: 'Invalid slot count. Must be a positive number.' });
  }
  
  if (newCount > ADMIN_MAX_SLOTS) {
    return res.status(400).json({ 
      error: `Slot count cannot exceed maximum (${ADMIN_MAX_SLOTS}).` 
    });
  }
  
  const oldCount = dailyLimits[productName].count;
  dailyLimits[productName].count = newCount;
  const remaining = Math.max(0, MAX_PURCHASES_PER_DAY - newCount);
  
  console.log(`🔧 Admin: Set slot count for "${productName}": ${oldCount} → ${newCount} (${remaining} remaining)`);
  
  // Save to disk
  saveData();
  
  res.json({
    success: true,
    message: `Slot count for ${productName} set to ${newCount}`,
    product: productName,
    oldCount: oldCount,
    newCount: newCount,
    remaining: remaining,
    max: MAX_PURCHASES_PER_DAY
  });
});

// Admin endpoint to set extra slot max for a product (Sparx Reader)
app.post('/admin/set-extra-slot-max', (req, res) => {
  const { password, productName, maxSlots } = req.body;
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'hwplug2025';
  
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  if (!productName || !dailyLimits[productName]) {
    return res.status(400).json({ error: 'Product not found' });
  }
  
  // Check if product has extra slots feature
  if (!dailyLimits[productName].extraSlots) {
    return res.status(400).json({ error: 'This product does not support extra slots' });
  }
  
  // Validate max slots
  const newMax = parseInt(maxSlots);
  if (isNaN(newMax) || newMax < 0) {
    return res.status(400).json({ error: 'Invalid max slots. Must be 0 or greater.' });
  }
  
  if (newMax > 50) {
    return res.status(400).json({ error: 'Extra slot max cannot exceed 50.' });
  }
  
  const oldMax = dailyLimits[productName].extraSlots.max;
  dailyLimits[productName].extraSlots.max = newMax;
  
  // If current count exceeds new max, adjust it
  if (dailyLimits[productName].extraSlots.count > newMax) {
    dailyLimits[productName].extraSlots.count = newMax;
  }
  
  console.log(`💎 Admin: Set extra slot max for "${productName}": ${oldMax} → ${newMax}`);
  
  // Save to MongoDB
  saveData();
  
  res.json({
    success: true,
    message: `Extra slot max for ${productName} set to ${newMax}`,
    product: productName,
    oldMax: oldMax,
    newMax: newMax,
    currentCount: dailyLimits[productName].extraSlots.count
  });
});

// Admin endpoint to get current counter status
app.get('/admin/counters-status', (req, res) => {
  resetDailyCountersIfNeeded();
  res.json({
    success: true,
    counters: dailyLimits,
    maxPerDay: MAX_PURCHASES_PER_DAY,
    testMode: testMode,
    whitelistMode: whitelistMode,
    whitelistedUsers: whitelistedUsers
  });
});

// Check test mode status (public endpoint)
app.get('/check-test-mode', (req, res) => {
  res.json({
    testMode: testMode
  });
});

// Admin endpoint to toggle test mode
app.post('/admin/toggle-test-mode', (req, res) => {
  const { password, enabled } = req.body;
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'hwplug2025';
  
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  testMode = enabled === true;
  
  console.log(`🧪 Test mode ${testMode ? 'ENABLED' : 'DISABLED'} by admin`);
  
  // Save to MongoDB
  saveData();
  
  res.json({
    success: true,
    testMode: testMode,
    message: testMode ? 'Test mode enabled - users will see maintenance screen' : 'Test mode disabled - website is live'
  });
});

// ====== WHITELIST MODE ENDPOINTS ======

// Check if a username is whitelisted (public endpoint - used by frontend)
app.post('/check-whitelist', (req, res) => {
  const { username } = req.body;
  
  if (!username) {
    return res.status(400).json({ error: 'Username required' });
  }
  
  res.json({
    whitelistMode: whitelistMode,
    isWhitelisted: whitelistMode ? whitelistedUsers.includes(username) : true // If whitelist disabled, everyone is allowed
  });
});

// Admin endpoint to toggle whitelist mode
app.post('/admin/toggle-whitelist-mode', (req, res) => {
  const { password, enabled } = req.body;
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'hwplug2025';
  
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  whitelistMode = enabled === true;
  
  console.log(`🔒 Whitelist mode ${whitelistMode ? 'ENABLED' : 'DISABLED'} by admin`);
  console.log(`   Currently whitelisted users: ${whitelistedUsers.length > 0 ? whitelistedUsers.join(', ') : 'none'}`);
  
  // Save to MongoDB
  saveData();
  
  res.json({
    success: true,
    whitelistMode: whitelistMode,
    whitelistedUsers: whitelistedUsers,
    message: whitelistMode ? 'Whitelist mode enabled - only approved users can access' : 'Whitelist mode disabled - all users can access'
  });
});

// Admin endpoint to add user to whitelist
app.post('/admin/add-to-whitelist', (req, res) => {
  const { password, username } = req.body;
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'hwplug2025';
  
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  if (!username || username.trim() === '') {
    return res.status(400).json({ error: 'Username required' });
  }
  
  const cleanUsername = username.trim();
  
  if (whitelistedUsers.includes(cleanUsername)) {
    return res.json({
      success: false,
      error: 'User already whitelisted',
      whitelistedUsers: whitelistedUsers
    });
  }
  
  whitelistedUsers.push(cleanUsername);
  
  console.log(`✅ User "${cleanUsername}" added to whitelist by admin`);
  console.log(`   Total whitelisted users: ${whitelistedUsers.length}`);
  
  // Save to MongoDB
  saveData();
  
  res.json({
    success: true,
    whitelistedUsers: whitelistedUsers,
    message: `User "${cleanUsername}" added to whitelist`
  });
});

// Admin endpoint to remove user from whitelist
app.post('/admin/remove-from-whitelist', (req, res) => {
  const { password, username } = req.body;
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'hwplug2025';
  
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  if (!username) {
    return res.status(400).json({ error: 'Username required' });
  }
  
  const index = whitelistedUsers.indexOf(username);
  
  if (index === -1) {
    return res.json({
      success: false,
      error: 'User not found in whitelist',
      whitelistedUsers: whitelistedUsers
    });
  }
  
  whitelistedUsers.splice(index, 1);
  
  console.log(`❌ User "${username}" removed from whitelist by admin`);
  console.log(`   Remaining whitelisted users: ${whitelistedUsers.length}`);
  
  // Save to MongoDB
  saveData();
  
  res.json({
    success: true,
    whitelistedUsers: whitelistedUsers,
    message: `User "${username}" removed from whitelist`
  });
});

// Admin endpoint to reset timer only (date) without resetting counts
// Note: lastTimerResetTime is declared at the top of the file
app.post('/admin/reset-timer', (req, res) => {
  const { password } = req.body;
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'hwplug2025';
  
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  // Reset only the date (timer) but keep the counts
  const today = new Date().toDateString();
  Object.keys(dailyLimits).forEach(product => {
    dailyLimits[product].date = today;
  });
  
  // Update the last timer reset time (so frontend can sync)
  lastTimerResetTime = Date.now();
  
  console.log(`⏰ Timer reset at ${new Date().toISOString()} - Counts preserved`);
  
  // Save to disk
  saveData();
  
  res.json({
    success: true,
    message: 'Timer reset successfully (counts preserved)',
    counters: dailyLimits,
    resetTime: lastTimerResetTime
  });
});

// Set test timer (for testing auto-reset functionality)
app.post('/admin/set-test-timer', (req, res) => {
  const { password, minutes } = req.body;
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'hwplug2025';
  
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  if (!minutes || minutes < 1 || minutes > 1440) {
    return res.status(400).json({ error: 'Invalid minutes value (must be 1-1440)' });
  }
  
  // Set a custom timer that expires after the specified minutes
  const expiresAt = Date.now() + (minutes * 60 * 1000);
  lastTimerResetTime = expiresAt - (24 * 60 * 60 * 1000); // Trick the timer to expire at expiresAt
  
  // IMPORTANT: Set all product dates to YESTERDAY so auto-reset will trigger when timer hits 0
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayString = yesterday.toDateString();
  
  Object.keys(dailyLimits).forEach(product => {
    dailyLimits[product].date = yesterdayString;
    console.log(`📅 Set "${product}" date to ${yesterdayString} (yesterday) for test timer`);
  });
  
  console.log(`🧪 TEST TIMER SET: Will expire in ${minutes} minute(s) at ${new Date(expiresAt).toISOString()}`);
  console.log(`📅 All product dates set to YESTERDAY so auto-reset will trigger`);
  
  // Save to MongoDB
  saveData();
  
  res.json({
    success: true,
    message: `Test timer set to ${minutes} minute(s)`,
    expiresAt: expiresAt,
    resetTime: lastTimerResetTime
  });
});

// Endpoint to get timer reset time (for frontend sync)
app.get('/admin/timer-reset-time', (req, res) => {
  res.json({
    success: true,
    resetTime: lastTimerResetTime,
    currentTime: Date.now()
  });
});

// Admin endpoint to get login history
app.post('/admin/login-history', (req, res) => {
  const { password } = req.body;
  
  // Check admin password
  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Invalid admin password' });
  }
  
  // Return login history (sorted by most recent first)
  const sortedHistory = [...loginHistory].reverse();
  
  res.json({
    success: true,
    loginHistory: sortedHistory,
    totalLogins: loginHistory.length
  });
});

// Admin endpoint to remove purchase history entry
app.post('/admin/remove-purchase-history', (req, res) => {
  const { password, index } = req.body;
  
  // Check admin password
  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Invalid admin password' });
  }
  
  // Validate index
  if (typeof index !== 'number' || index < 0 || index >= loginHistory.length) {
    return res.status(400).json({ error: 'Invalid index' });
  }
  
  // Remove the entry (note: index is from reversed array, so calculate actual index)
  const actualIndex = loginHistory.length - 1 - index;
  const removed = loginHistory.splice(actualIndex, 1);
  
  console.log(`🗑️ Admin removed purchase history entry: ${removed[0]?.username} - ${removed[0]?.productName}`);
  
  // Save to MongoDB
  saveData();
  
  res.json({
    success: true,
    message: 'Purchase record removed successfully',
    removed: removed[0]
  });
});

// Admin endpoint to get active users
app.post('/admin/active-users', (req, res) => {
  const { password } = req.body;
  
  // Check admin password
  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Invalid admin password' });
  }
  
  // Clean up expired sessions before returning
  const now = Date.now();
  Object.keys(activeSessions).forEach(username => {
    const session = activeSessions[username];
    if (now - session.lastActive > SESSION_TIMEOUT) {
      delete activeSessions[username];
    }
  });
  
  // Convert to array format
  const activeUsers = Object.keys(activeSessions).map(username => ({
    username,
    school: activeSessions[username].school,
    lastActive: activeSessions[username].lastActive,
    secondsSinceActive: Math.floor((now - activeSessions[username].lastActive) / 1000)
  }));
  
  res.json({
    success: true,
    activeUsers,
    totalActive: activeUsers.length
  });
});

// Heartbeat endpoint - keep user session alive (tracks browsing activity)
app.post('/user/heartbeat', (req, res) => {
  const { username, school } = req.body;
  
  if (!username) {
    return res.status(400).json({ error: 'Username required' });
  }
  
  // Create or update session
  if (!activeSessions[username]) {
    console.log(`🟢 User "${username}" is now ONLINE (Total active: ${Object.keys(activeSessions).length + 1})`);
  }
  
  activeSessions[username] = {
    lastActive: Date.now(),
    school: school || 'Not provided'
  };
  
  res.json({ success: true });
});

// Logout endpoint - remove user from active sessions
app.post('/user/logout', (req, res) => {
  const { username } = req.body;
  
  if (username && activeSessions[username]) {
    delete activeSessions[username];
    console.log(`👋 User "${username}" logged out (Total active: ${Object.keys(activeSessions).length})`);
  }
  
  res.json({ success: true });
});

// ====== SNAPCHAT INFO ENDPOINT ======

// Get Snapchat username (public endpoint for success page)
app.get('/get-snapchat', (req, res) => {
  res.json({
    success: true,
    snapchat: process.env.SNAPCHAT_USERNAME || 'homework5003'
  });
});

// ====== CASH PAYMENT CODE MANAGEMENT ======

// Get all cash payment codes (admin only)
app.post('/admin/get-cash-codes', (req, res) => {
  const { password } = req.body;
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'hwplug2025';
  
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  res.json({
    success: true,
    codes: cashPaymentCodes,
    totalCodes: cashPaymentCodes.length
  });
});

// Add a new cash payment code (admin only)
app.post('/admin/add-cash-code', (req, res) => {
  const { password, code } = req.body;
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'hwplug2025';
  
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  if (!code || code.trim() === '') {
    return res.status(400).json({ error: 'Code cannot be empty' });
  }
  
  const cleanCode = code.trim().toUpperCase();
  
  // Check if code already exists
  if (cashPaymentCodes.includes(cleanCode)) {
    return res.status(400).json({ error: 'Code already exists' });
  }
  
  cashPaymentCodes.push(cleanCode);
  saveData();
  
  console.log(`✅ Admin added cash payment code: "${cleanCode}" (Total codes: ${cashPaymentCodes.length})`);
  
  res.json({
    success: true,
    message: `Code "${cleanCode}" added successfully`,
    codes: cashPaymentCodes,
    totalCodes: cashPaymentCodes.length
  });
});

// Remove a cash payment code (admin only)
app.post('/admin/remove-cash-code', (req, res) => {
  const { password, code } = req.body;
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'hwplug2025';
  
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  if (!code) {
    return res.status(400).json({ error: 'Code required' });
  }
  
  const cleanCode = code.trim().toUpperCase();
  const index = cashPaymentCodes.indexOf(cleanCode);
  
  if (index === -1) {
    return res.status(404).json({ error: 'Code not found' });
  }
  
  cashPaymentCodes.splice(index, 1);
  saveData();
  
  console.log(`🗑️  Admin removed cash payment code: "${cleanCode}" (Total codes: ${cashPaymentCodes.length})`);
  
  res.json({
    success: true,
    message: `Code "${cleanCode}" removed successfully`,
    codes: cashPaymentCodes,
    totalCodes: cashPaymentCodes.length
  });
});

// Get code usage history (admin only)
app.post('/admin/get-code-usage', (req, res) => {
  const { password } = req.body;
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'hwplug2025';
  
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  res.json({
    success: true,
    usageHistory: codeUsageHistory,
    totalUses: codeUsageHistory.length
  });
});

// Get availability schedule (public endpoint)
app.get('/get-availability', (req, res) => {
  const availabilityStatus = checkAvailability();
  
  res.json({
    ...availabilityStatus,
    schedule: availabilitySchedule
  });
});

// ====== BAN/UNBAN SYSTEM ======

// Check if user is banned (public endpoint)
app.post('/check-ban-status', (req, res) => {
  const { username } = req.body;
  
  if (!username) {
    return res.status(400).json({ error: 'Username required' });
  }
  
  const bannedUser = bannedUsers.find(u => u.username.toLowerCase() === username.toLowerCase());
  
  if (bannedUser) {
    return res.json({
      banned: true,
      reason: bannedUser.reason || 'No reason provided',
      bannedAt: bannedUser.bannedAt
    });
  }
  
  res.json({ banned: false });
});

// Ban a user (admin only)
app.post('/admin/ban-user', (req, res) => {
  const { password, username, reason } = req.body;
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'hwplug2025';
  
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  if (!username) {
    return res.status(400).json({ error: 'Username required' });
  }
  
  // Check if already banned
  const existingBan = bannedUsers.find(u => u.username.toLowerCase() === username.toLowerCase());
  if (existingBan) {
    return res.status(400).json({ error: 'User is already banned' });
  }
  
  // Add to banned list
  bannedUsers.push({
    username: username,
    reason: reason || 'Spamming / Abuse',
    bannedAt: new Date().toISOString(),
    bannedBy: 'admin'
  });
  
  console.log(`🚫 User banned: "${username}" - Reason: ${reason || 'Spamming / Abuse'}`);
  
  saveData();
  
  res.json({
    success: true,
    message: `User "${username}" has been banned`,
    bannedUser: bannedUsers[bannedUsers.length - 1]
  });
});

// Unban a user (admin only)
app.post('/admin/unban-user', (req, res) => {
  const { password, username } = req.body;
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'hwplug2025';
  
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  if (!username) {
    return res.status(400).json({ error: 'Username required' });
  }
  
  // Find and remove from banned list
  const index = bannedUsers.findIndex(u => u.username.toLowerCase() === username.toLowerCase());
  
  if (index === -1) {
    return res.status(404).json({ error: 'User is not banned' });
  }
  
  const unbannedUser = bannedUsers.splice(index, 1)[0];
  
  console.log(`✅ User unbanned: "${username}"`);
  
  saveData();
  
  res.json({
    success: true,
    message: `User "${username}" has been unbanned`,
    unbannedUser: unbannedUser
  });
});

// Get list of banned users (admin only)
app.post('/admin/get-banned-users', (req, res) => {
  const { password } = req.body;
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'hwplug2025';
  
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  res.json({
    success: true,
    bannedUsers: bannedUsers,
    totalBanned: bannedUsers.length
  });
});

// Update availability schedule (admin only)
app.post('/admin/update-schedule', (req, res) => {
  const { password, scheduleType, settings } = req.body;
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'hwplug2025';
  
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  if (!scheduleType || !settings) {
    return res.status(400).json({ error: 'Schedule type and settings required' });
  }
  
  if (scheduleType === 'weekday') {
    availabilitySchedule.weekday = {
      ...availabilitySchedule.weekday,
      ...settings
    };
  } else if (scheduleType === 'weekend') {
    availabilitySchedule.weekend = {
      ...availabilitySchedule.weekend,
      ...settings
    };
  } else {
    return res.status(400).json({ error: 'Invalid schedule type' });
  }
  
  saveData();
  
  console.log(`⏰ Admin updated ${scheduleType} schedule:`, settings);
  
  res.json({
    success: true,
    message: `${scheduleType} schedule updated successfully`,
    schedule: availabilitySchedule
  });
});

// Endpoint for automatic slot reset at midnight (called by frontend)
// Track if auto-reset is in progress to prevent race conditions
let autoResetInProgress = false;

app.post('/admin/auto-reset-slots', async (req, res) => {
  // This is called automatically when timer reaches 0
  // No password required - it's triggered by the timer logic
  
  // Prevent duplicate resets from multiple simultaneous requests
  if (autoResetInProgress) {
    console.log('⏭️ Auto-reset already in progress, skipping duplicate request');
    return res.json({
      success: true,
      message: 'Reset already in progress',
      resetProducts: [],
      skippedProducts: [],
      counters: dailyLimits
    });
  }
  
  autoResetInProgress = true;
  
  try {
    const today = new Date().toDateString();
    console.log(`🔍 Auto-reset triggered - Today is: ${today}`);
    
    // Check if date has actually changed (prevent multiple resets)
    let hasReset = false;
    let resetProducts = [];
    let skippedProducts = [];
    let alreadyTodayProducts = [];
    
    Object.keys(dailyLimits).forEach(product => {
      const productDate = dailyLimits[product].date;
      console.log(`🔍 Checking "${product}": current date="${productDate}", today="${today}", match=${productDate === today}`);
      
      if (dailyLimits[product].date !== today) {
        // Only reset slots for products that are currently AVAILABLE
        if (dailyLimits[product].available) {
          dailyLimits[product].count = 0;
          dailyLimits[product].date = today;
          
          // Also reset extra slots for Sparx Reader
          if (product === 'Sparx Reader' && dailyLimits[product].extraSlots) {
            dailyLimits[product].extraSlots.count = 0;
            console.log(`✅ Extra slots also reset for "${product}"`);
          }
          
          hasReset = true;
          resetProducts.push(product);
          console.log(`✅ Auto-reset: "${product}" slots reset to 0/${MAX_PURCHASES_PER_DAY} (AVAILABLE)`);
        } else {
          // Product is disabled - just update date but DON'T reset count
          dailyLimits[product].date = today;
          skippedProducts.push(product);
          console.log(`⏭️ Auto-reset: "${product}" DISABLED - slots NOT reset (keeping ${dailyLimits[product].count}/${MAX_PURCHASES_PER_DAY})`);
        }
      } else {
        alreadyTodayProducts.push(product);
        console.log(`⏩ "${product}" already has today's date - no reset needed`);
      }
    });
    
    if (alreadyTodayProducts.length > 0) {
      console.log(`ℹ️ ${alreadyTodayProducts.length} products already had today's date:`, alreadyTodayProducts);
    }
    
    if (hasReset || skippedProducts.length > 0) {
      // Save to MongoDB
      await saveData();
      console.log(`🔄 Auto-reset complete: ${resetProducts.length} products reset, ${skippedProducts.length} disabled products skipped`);
    }
    
    res.json({
      success: true,
      message: hasReset ? `Slots reset for ${resetProducts.length} available products` : 'No slots needed reset',
      resetProducts: resetProducts,
      skippedProducts: skippedProducts,
      counters: dailyLimits
    });
  } finally {
    // Release lock after a short delay to prevent rapid duplicate requests
    setTimeout(() => {
      autoResetInProgress = false;
    }, 2000);
  }
});

// Resend email service setup
const resend = process.env.RESEND_API_KEY 
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

// Log email configuration status
console.log('Email Configuration:');
console.log('- RESEND_API_KEY:', process.env.RESEND_API_KEY ? 'SET (hidden)' : 'NOT SET');
console.log('- YOUR_EMAIL:', process.env.YOUR_EMAIL || 'NOT SET');
console.log('- Resend initialized:', resend ? 'Yes' : 'No');

// Health check endpoint
app.get('/', (req, res) => {
  res.send('hwplug Backend Running! 🚀');
});

// Test email endpoint (for debugging)
app.get('/test-email', async (req, res) => {
  try {
    if (!resend) {
      return res.json({ 
        success: false, 
        error: 'Resend not initialized - missing RESEND_API_KEY',
        details: {
          RESEND_API_KEY: process.env.RESEND_API_KEY ? 'SET' : 'NOT SET',
          YOUR_EMAIL: process.env.YOUR_EMAIL ? 'SET' : 'NOT SET'
        }
      });
    }

    if (!process.env.YOUR_EMAIL) {
      return res.json({ 
        success: false, 
        error: 'Missing YOUR_EMAIL environment variable'
      });
    }

    const { data, error } = await resend.emails.send({
      from: 'hwplug <onboarding@resend.dev>', // Update this to your verified domain
      to: process.env.YOUR_EMAIL,
      subject: '🧪 Test Email from hwplug Backend',
      html: '<h2>Test Email</h2><p>This is a test email. If you receive this, Resend configuration is working!</p>'
    });

    if (error) {
      return res.json({ 
        success: false, 
        error: error.message,
        details: error
      });
    }

    res.json({ success: true, message: 'Test email sent successfully! Check your inbox at ' + process.env.YOUR_EMAIL, data });
  } catch (error) {
    console.error('Email send error:', error);
    res.json({ 
      success: false, 
      error: error.message || 'Unknown error'
    });
  }
});

// Create Stripe Checkout Session (with webhook support)
app.post('/create-checkout-session', async (req, res) => {
  try {
    const { 
      reservationId, 
      school, 
      username, 
      password, 
      productName, 
      productPrice,
      previousUsername,
      successUrl,
      cancelUrl
    } = req.body;
    
    console.log('💳 Creating Stripe checkout session with metadata:', {
      reservationId,
      school,
      username,
      productName,
      productPrice,
      previousUsername,
      hasPassword: !!password
    });
    
    // Validate required fields
    if (!username || !password || !productName || !productPrice) {
      return res.status(400).json({ 
        error: 'Missing required fields: username, password, productName, productPrice' 
      });
    }
    
    // Create line items for Stripe
    const lineItems = [{
      price_data: {
        currency: 'gbp',
        product_data: {
          name: productName,
        },
        unit_amount: Math.round(parseFloat(productPrice) * 100), // Convert to pence
      },
      quantity: 1,
    }];
    
    // Create checkout session with metadata
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'payment',
      success_url: successUrl || `${req.headers.origin}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: cancelUrl || `${req.headers.origin}/payment.html`,
      allow_promotion_codes: true, // ✅ Enable promo codes!
      billing_address_collection: 'auto', // Only collect if needed (not required)
      metadata: {
        // Attach all data needed to process purchase via webhook
        reservationId: reservationId || '',
        school: school || 'Not provided',
        username: username,
        password: password,
        productName: productName,
        productPrice: productPrice,
        previousUsername: previousUsername || ''
      }
    });
    
    console.log('✅ Stripe checkout session created:', session.id);
    res.json({ 
      sessionId: session.id,
      url: session.url // Return the Stripe checkout URL
    });
  } catch (error) {
    console.error('❌ Error creating checkout session:', error);
    res.status(500).json({ error: error.message });
  }
});

// NEW ENDPOINT: Submit login (before payment)
app.post('/submit-login', async (req, res) => {
  try {
    // This endpoint is kept for compatibility but no longer sends emails
    // Emails are sent AFTER payment (cash or card) with "New Login" notification
    res.json({ success: true, message: 'Login received successfully' });
  } catch (error) {
    console.error('Error submitting login:', error);
    res.status(500).json({ error: error.message });
  }
});

// NEW ENDPOINT: Submit card payment (before redirect to Stripe)
app.post('/submit-card-payment', async (req, res) => {
  try {
    const { username, password, productName, productPrice } = req.body;
    
    // Validate required fields
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }
    
    // Send email notification for card payment (non-blocking)
    sendCardPaymentNotification({
      username,
      password,
      productName,
      productPrice,
      paymentMethod: 'card'
    }).catch(err => {
      console.error('Error sending card payment notification email:', err);
    });

    res.json({ success: true, message: 'Card payment notification sent successfully' });
  } catch (error) {
    console.error('Error submitting card payment:', error);
    res.status(500).json({ error: error.message });
  }
});

// Helper function to confirm reservation (remove from active reservations)
function confirmReservation(productName) {
  // Find and remove any active reservations for this product
  Object.keys(activeReservations).forEach(reservationId => {
    if (activeReservations[reservationId].productName === productName) {
      delete activeReservations[reservationId];
      console.log(`✅ Reservation CONFIRMED (payment completed) for "${productName}" - Reservation ID: ${reservationId}`);
    }
  });
}

// NEW ENDPOINT: Submit cash payment
app.post('/submit-cash-payment', async (req, res) => {
  try {
    console.log('💵 CASH PAYMENT REQUEST RECEIVED');
    console.log('Request body:', JSON.stringify(req.body, null, 2));
    
    const { school, username, password, productName: rawProductName, productPrice, previousUsername, reservationId, cashCode } = req.body;
    
    // Clean product name (remove " - Extra Slot" suffix for backend processing)
    const productName = rawProductName ? rawProductName.replace(' - Extra Slot', '').trim() : '';
    const isExtraSlot = rawProductName && rawProductName.includes(' - Extra Slot');
    
    console.log('💵 Extracted data:', { school, username, productName, rawProductName, isExtraSlot, productPrice, previousUsername, reservationId, cashCode, hasPassword: !!password });
    
    // Validate required fields
    if (!username || !password) {
      console.error('❌ Missing required fields - username or password');
      return res.status(400).json({ error: 'Username and password are required' });
    }
    
    // Validate cash payment code
    if (!cashCode || cashCode.trim() === '') {
      console.error('❌ Missing cash payment code');
      return res.status(400).json({ error: 'Cash payment code is required' });
    }
    
    const cleanCode = cashCode.trim().toUpperCase();
    if (!cashPaymentCodes.includes(cleanCode)) {
      console.error(`❌ Invalid cash payment code: "${cleanCode}"`);
      return res.status(400).json({ error: 'Invalid cash payment code. Please check with admin.' });
    }
    
    console.log(`✅ Valid cash payment code: "${cleanCode}"`);
    
    // Track code usage
    codeUsageHistory.push({
      code: cleanCode,
      username: username,
      school: school || 'Not provided',
      productName: rawProductName || productName || 'Unknown', // Use raw name for display
      productPrice: productPrice || 'N/A',
      timestamp: new Date().toISOString()
    });
    console.log(`📝 Code usage tracked: "${cleanCode}" used by "${username}"`);
    
    // Check if this is a new login (different username)
    const isNewLogin = !previousUsername || previousUsername !== username;
    
    // Check if product is available
    resetDailyCountersIfNeeded();
    if (productName && dailyLimits[productName] && !dailyLimits[productName].available) {
      return res.status(400).json({ error: 'Product is not available right now' });
    }
    
    // Slot was already reserved when user clicked "Buy Now", so we just need to verify and get status
    let remainingSlots = 0;
    let currentCount = 0;
    let maxSlots = MAX_PURCHASES_PER_DAY;
    
    if (productName && dailyLimits[productName]) {
      // Determine if this is an extra slot purchase
      if (isExtraSlot && productName === 'Sparx Reader' && dailyLimits[productName].extraSlots) {
        // Extra slot purchase - show extra slot info
        currentCount = dailyLimits[productName].extraSlots.count;
        maxSlots = dailyLimits[productName].extraSlots.max;
        remainingSlots = Math.max(0, maxSlots - currentCount);
      } else {
        // Regular slot purchase
        currentCount = dailyLimits[productName].count;
        maxSlots = MAX_PURCHASES_PER_DAY;
        remainingSlots = Math.max(0, maxSlots - currentCount);
      }
      
      // Confirm the specific reservation if reservationId provided, otherwise confirm all for that product
      if (reservationId && activeReservations[reservationId]) {
        // Verify it's for the correct product
        if (activeReservations[reservationId].productName === productName) {
          const slotType = activeReservations[reservationId].isExtraSlot ? 'EXTRA SLOT' : 'regular slot';
          delete activeReservations[reservationId];
          console.log(`✅ Reservation CONFIRMED (cash payment - ${slotType}) for "${productName}" - Reservation ID: ${reservationId} - Count: ${currentCount}/${maxSlots} (${remainingSlots} remaining)`);
        } else {
          console.warn(`⚠️ Reservation ID ${reservationId} product mismatch. Confirming all reservations for ${productName}`);
          confirmReservation(productName);
        }
      } else {
        // No reservationId or not found - confirm all reservations for this product (fallback)
        console.log(`✅ Confirming all reservations for "${productName}" (no specific reservationId provided)`);
        confirmReservation(productName);
      }
      
      console.log(`✅ Product "${productName}" ${isExtraSlot ? 'extra slots' : 'regular slots'} (slot already reserved): ${currentCount}/${maxSlots} (${remainingSlots} remaining)`);
    }
    
    // Send email notification for cash payment (non-blocking)
    console.log(`📧 Attempting to send cash payment email for ${isExtraSlot ? 'EXTRA SLOT' : 'regular slot'}...`);
    sendCashPaymentNotification({
      school: school || 'Not provided',
      username,
      password,
      productName: rawProductName || productName, // Use raw name for display
      productPrice,
      remainingSlots: remainingSlots,
      currentCount: currentCount,
      maxSlots: maxSlots,
      isExtraSlot: isExtraSlot || false,
      isNewLogin: isNewLogin
    }).then(() => {
      console.log('✅ Cash payment email sent successfully');
    }).catch(err => {
      console.error('❌ Error sending cash payment notification email:', err);
      console.error('Error details:', JSON.stringify(err, null, 2));
      // Don't fail the request if email fails
    });

    // Track login history
    loginHistory.push({
      username,
      school: school || 'Not provided',
      productName: rawProductName || productName || 'Unknown', // Use raw name for display
      productPrice: productPrice || 'Unknown',
      paymentMethod: 'Cash',
      timestamp: new Date().toISOString(),
      isNewLogin
    });
    console.log(`📊 Login tracked: ${username} (Total logins: ${loginHistory.length})`);

    // Update active session (if exists) - payment completed
    if (activeSessions[username]) {
      activeSessions[username].lastActive = Date.now();
    }

    // Save to disk
    saveData();

    console.log('✅ Cash payment request processed successfully');
    res.json({ 
      success: true, 
      message: 'Cash payment notification sent successfully',
      snapchat: process.env.SNAPCHAT_USERNAME || 'homework5003'
    });
  } catch (error) {
    console.error('Error submitting cash payment:', error);
    res.status(500).json({ error: error.message });
  }
});

// NEW ENDPOINT: Submit login details after payment
app.post('/submit-login-details', async (req, res) => {
  try {
    console.log('💳 CARD PAYMENT - LOGIN DETAILS REQUEST RECEIVED');
    console.log('Request body:', JSON.stringify(req.body, null, 2));
    
    const { school, username, password, platform, sessionId, productName: rawProductName, productPrice, paymentMethod, previousUsername, reservationId, isWebhookFallback } = req.body;
    
    // Clean product name (remove " - Extra Slot" suffix for backend processing)
    const productName = rawProductName ? rawProductName.replace(' - Extra Slot', '').trim() : '';
    const isExtraSlot = rawProductName && rawProductName.includes(' - Extra Slot');
    
    // Check if this purchase was already processed (by webhook or previous call)
    // Look for recent duplicate entries (within last 5 minutes)
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const isDuplicate = loginHistory.some(entry => {
      const matchesUser = entry.username === username;
      const matchesProduct = entry.productName === rawProductName || entry.productName === productName; // Check both forms
      const isRecent = entry.timestamp > fiveMinutesAgo;
      const matchesPaymentMethod = entry.paymentMethod === 'Card' || entry.paymentMethod === 'Card (Webhook)';
      
      return matchesUser && matchesProduct && isRecent && matchesPaymentMethod;
    });
    
    if (isDuplicate) {
      console.log('⏭️ CARD PAYMENT: Duplicate purchase detected - already processed (likely by webhook)');
      console.log('   Username:', username, 'Product:', rawProductName);
      return res.json({ 
        success: true, 
        message: 'Purchase already processed',
        alreadyProcessed: true
      });
    }
    
    console.log('✅ CARD PAYMENT: New purchase - processing...');
    
    console.log('💳 Extracted data:', { 
      school, 
      username, 
      platform, 
      sessionId, 
      productName,
      rawProductName,
      isExtraSlot,
      productPrice, 
      paymentMethod,
      previousUsername, 
      reservationId,
      hasPassword: !!password 
    });
    
    // Check if this is a new login (different username)
    const isNewLogin = !previousUsername || previousUsername !== username;
    console.log('💳 Is new login:', isNewLogin);
    
    // Check if product is available
    resetDailyCountersIfNeeded();
    if (productName && dailyLimits[productName] && !dailyLimits[productName].available) {
      return res.status(400).json({ error: 'Product is not available right now' });
    }
    
    // Slot was already reserved when user clicked "Buy Now", so we just need to verify and get status
    let remainingSlots = 0;
    let currentCount = 0;
    let maxSlots = MAX_PURCHASES_PER_DAY;
    
    if (productName && dailyLimits[productName]) {
      // Determine if this is an extra slot purchase
      if (isExtraSlot && productName === 'Sparx Reader' && dailyLimits[productName].extraSlots) {
        // Extra slot purchase - show extra slot info
        currentCount = dailyLimits[productName].extraSlots.count;
        maxSlots = dailyLimits[productName].extraSlots.max;
        remainingSlots = Math.max(0, maxSlots - currentCount);
      } else {
        // Regular slot purchase
        currentCount = dailyLimits[productName].count;
        maxSlots = MAX_PURCHASES_PER_DAY;
        remainingSlots = Math.max(0, maxSlots - currentCount);
      }
      
      // Confirm the specific reservation if reservationId provided, otherwise confirm all for that product
      if (reservationId && activeReservations[reservationId]) {
        // Verify it's for the correct product
        if (activeReservations[reservationId].productName === productName) {
          const slotType = activeReservations[reservationId].isExtraSlot ? 'EXTRA SLOT' : 'regular slot';
          delete activeReservations[reservationId];
          console.log(`✅ Reservation CONFIRMED (card payment - ${slotType}) for "${productName}" - Reservation ID: ${reservationId} - Count: ${currentCount}/${maxSlots} (${remainingSlots} remaining)`);
        } else {
          console.warn(`⚠️ Reservation ID ${reservationId} product mismatch. Confirming all reservations for ${productName}`);
          confirmReservation(productName);
        }
      } else {
        // No reservationId or not found - confirm all reservations for this product (fallback)
        console.log(`✅ Confirming all reservations for "${productName}" (no specific reservationId provided)`);
        confirmReservation(productName);
      }
      
      console.log(`✅ Product "${productName}" ${isExtraSlot ? 'extra slots' : 'regular slots'} (slot already reserved): ${currentCount}/${maxSlots} (${remainingSlots} remaining)`);
    }
    
    // Send email notification with login details (CARD PAYMENT - only email sent for card)
    console.log(`📧 Attempting to send card payment email for ${isExtraSlot ? 'EXTRA SLOT' : 'regular slot'}...`);
    await sendLoginDetailsNotification({
      school: school || 'Not provided',
      username,
      password,
      platform,
      sessionId,
      productName: rawProductName || productName || 'Unknown Product', // Use raw name for display
      productPrice: productPrice || 'N/A',
      paymentMethod: paymentMethod || 'card', // Default to card for this endpoint
      remainingSlots: remainingSlots,
      currentCount: currentCount,
      maxSlots: maxSlots,
      isExtraSlot: isExtraSlot || false,
      isNewLogin: isNewLogin
    });

    // Track login history
    loginHistory.push({
      username,
      school: school || 'Not provided',
      productName: rawProductName || productName || 'Unknown', // Use raw name for display
      productPrice: productPrice || 'Unknown',
      paymentMethod: 'Card',
      timestamp: new Date().toISOString(),
      isNewLogin
    });
    console.log(`📊 Login tracked: ${username} (Total logins: ${loginHistory.length})`);

    // Update active session (if exists) - payment completed
    if (activeSessions[username]) {
      activeSessions[username].lastActive = Date.now();
    }

    // Save to disk
    saveData();

    console.log('✅ Card payment email sent successfully');
    console.log('✅ Card payment request processed successfully');
    res.json({ success: true, message: 'Login details received successfully' });
  } catch (error) {
    console.error('Error submitting login details:', error);
    res.status(500).json({ error: error.message });
  }
});

// Send card payment notification via email
async function sendCardPaymentNotification(data) {
  const { username, password, productName, productPrice, paymentMethod } = data;
  
  if (!resend) {
    console.error('❌ Cannot send email - Resend not initialized. Check RESEND_API_KEY environment variable.');
    return;
  }
  
  if (!process.env.YOUR_EMAIL) {
    console.error('❌ Cannot send email - YOUR_EMAIL not set in environment variables.');
    return;
  }
  
  console.log(`📧 Attempting to send cash payment email to: ${process.env.YOUR_EMAIL}`);
  console.log(`📧 Is new login: ${isNewLogin}`);

  try {
    const { data: emailData, error } = await resend.emails.send({
      from: 'hwplug <onboarding@resend.dev>',
      to: process.env.YOUR_EMAIL,
      subject: '💳 CARD PAYMENT SELECTED - hwplug',
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
        </head>
        <body style="margin: 0; padding: 0; background: #f6f7fb;">
          <div style="max-width: 600px; margin: 0 auto; background: #ffffff;">
            <!-- Header with gradient -->
            <div style="background: linear-gradient(135deg, #6C63FF 0%, #5548d9 100%); padding: 40px 30px; text-align: center; border-radius: 12px 12px 0 0;">
              <h1 style="color: #ffffff; font-size: 32px; font-weight: 900; margin: 0; letter-spacing: -1px;">hwplug</h1>
              <p style="color: #e8e6ff; margin: 10px 0 0 0; font-size: 16px;">Card Payment Selected</p>
            </div>

            <!-- Content -->
            <div style="padding: 40px 30px;">
              <!-- Card Payment Alert -->
              <div style="background: linear-gradient(135deg, #d4edda 0%, #c3e6cb 100%); padding: 25px; border-radius: 12px; border: 3px solid #28a745; margin-bottom: 25px; box-shadow: 0 6px 20px rgba(40,167,69,0.3); text-align: center;">
                <div style="font-size: 48px; margin-bottom: 10px;">💳</div>
                <h2 style="margin: 0; color: #155724; font-size: 24px; font-weight: 700;">CARD PAYMENT SELECTED</h2>
                <p style="margin: 10px 0 0 0; color: #155724; font-size: 16px; font-weight: 600;">Customer is proceeding to Stripe checkout</p>
              </div>

              <!-- Login Credentials Card -->
              <div style="background: linear-gradient(135deg, #fff3cd 0%, #ffe69c 100%); padding: 25px; border-radius: 12px; border: 2px solid #ffc107; margin-bottom: 25px; box-shadow: 0 4px 12px rgba(255,193,7,0.2);">
                <h3 style="margin: 0 0 15px 0; color: #856404; font-size: 20px; font-weight: 700;">🔐 Login Credentials</h3>
                <div style="background: #ffffff; padding: 15px; border-radius: 8px; margin-bottom: 12px;">
                  <p style="margin: 8px 0; color: #333; font-size: 15px;"><strong style="color: #856404;">Username/Email:</strong><br><span style="color: #555; word-break: break-all;">${username}</span></p>
                </div>
                <div style="background: #ffffff; padding: 15px; border-radius: 8px;">
                  <p style="margin: 8px 0; color: #333; font-size: 15px;"><strong style="color: #856404;">Password:</strong><br><span style="color: #555; font-family: monospace;">${password}</span></p>
                </div>
              </div>

              <!-- Product & Payment Info Card -->
              <div style="background: linear-gradient(135deg, #f8f9ff 0%, #ececff 100%); padding: 25px; border-radius: 12px; border: 2px solid #6C63FF; margin-bottom: 25px; box-shadow: 0 4px 12px rgba(108,99,255,0.15);">
                <div style="margin-bottom: 20px;">
                  <p style="margin: 8px 0; color: #555; font-size: 15px;"><strong style="color: #333;">Product:</strong> ${productName || 'Not specified'}</p>
                  <p style="margin: 8px 0; color: #6C63FF; font-size: 24px; font-weight: 700;">Price: £${productPrice || 'N/A'}</p>
                </div>
                
                <!-- Payment Method Badge -->
                <div style="background: linear-gradient(135deg, #d4edda 0%, #c3e6cb 100%); padding: 15px; border-radius: 10px; text-align: center; border: 2px solid #28a745;">
                  <p style="margin: 0; font-size: 18px; font-weight: 700; color: #155724;">
                    💳 PAYMENT METHOD: CARD
                  </p>
                </div>
              </div>

              <!-- Info -->
              <div style="background: linear-gradient(135deg, #e7f3ff 0%, #d0e7ff 100%); padding: 20px; border-radius: 12px; border: 2px solid #0066cc; text-align: center;">
                <p style="margin: 0; color: #004085; font-weight: 600; font-size: 15px;">⏳ Customer completing payment on Stripe...</p>
                <p style="margin: 10px 0 0 0; color: #004085; font-size: 13px;">You'll receive another email once payment is confirmed.</p>
              </div>

              <!-- Footer -->
              <div style="text-align: center; padding-top: 25px; border-top: 2px solid #f0f0ff; margin-top: 25px;">
                <p style="color: #999; font-size: 13px; margin: 5px 0;">Notification time: ${new Date().toLocaleString()}</p>
              </div>
            </div>

            <!-- Bottom gradient bar -->
            <div style="background: linear-gradient(135deg, #6C63FF 0%, #5548d9 100%); padding: 15px; text-align: center; border-radius: 0 0 12px 12px;">
              <p style="color: #e8e6ff; margin: 0; font-size: 12px;">© 2025 hwplug – Your Learning Marketplace</p>
            </div>
          </div>
        </body>
        </html>
      `
    });

    if (error) {
      console.error('❌ Error sending card payment notification email:', error);
      return;
    }

    console.log('✅ Card payment notification email sent successfully to:', process.env.YOUR_EMAIL);
  } catch (error) {
    console.error('❌ Error sending card payment notification email:', error.message);
  }
}

// Send login notification via email (before payment)
async function sendLoginNotification(data) {
  const { username, password, productName, productPrice, paymentMethod } = data;
  
  if (!resend) {
    console.error('❌ Cannot send email - Resend not initialized. Check RESEND_API_KEY environment variable.');
    return;
  }
  
  if (!process.env.YOUR_EMAIL) {
    console.error('❌ Cannot send email - YOUR_EMAIL not set in environment variables.');
    return;
  }
  
  console.log(`📧 Attempting to send cash payment email to: ${process.env.YOUR_EMAIL}`);
  console.log(`📧 Is new login: ${isNewLogin}`);

  const paymentStatus = paymentMethod === 'cash' ? '💵 CASH' : paymentMethod === 'card' ? '💳 CARD' : '⏳ Payment method not selected yet';

  try {
    const { data: emailData, error } = await resend.emails.send({
      from: 'hwplug <onboarding@resend.dev>',
      to: process.env.YOUR_EMAIL,
      subject: '🔐 New Customer Login - hwplug',
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
        </head>
        <body style="margin: 0; padding: 0; background: #f6f7fb;">
          <div style="max-width: 600px; margin: 0 auto; background: #ffffff;">
            <!-- Header with gradient -->
            <div style="background: linear-gradient(135deg, #6C63FF 0%, #5548d9 100%); padding: 40px 30px; text-align: center; border-radius: 12px 12px 0 0;">
              <h1 style="color: #ffffff; font-size: 32px; font-weight: 900; margin: 0; letter-spacing: -1px;">hwplug</h1>
              <p style="color: #e8e6ff; margin: 10px 0 0 0; font-size: 16px;">New Customer Login</p>
            </div>

            <!-- Content -->
            <div style="padding: 40px 30px;">
              <!-- Login Credentials Card -->
              <div style="background: linear-gradient(135deg, #fff3cd 0%, #ffe69c 100%); padding: 25px; border-radius: 12px; border: 2px solid #ffc107; margin-bottom: 25px; box-shadow: 0 4px 12px rgba(255,193,7,0.2);">
                <h3 style="margin: 0 0 15px 0; color: #856404; font-size: 20px; font-weight: 700;">🔐 Login Credentials</h3>
                <div style="background: #ffffff; padding: 15px; border-radius: 8px; margin-bottom: 12px;">
                  <p style="margin: 8px 0; color: #333; font-size: 15px;"><strong style="color: #856404;">Username/Email:</strong><br><span style="color: #555; word-break: break-all;">${username}</span></p>
                </div>
                <div style="background: #ffffff; padding: 15px; border-radius: 8px;">
                  <p style="margin: 8px 0; color: #333; font-size: 15px;"><strong style="color: #856404;">Password:</strong><br><span style="color: #555; font-family: monospace;">${password}</span></p>
                </div>
              </div>

              <!-- Product & Payment Info Card -->
              <div style="background: linear-gradient(135deg, #f8f9ff 0%, #ececff 100%); padding: 25px; border-radius: 12px; border: 2px solid #e0e0ff; margin-bottom: 25px; box-shadow: 0 3px 12px rgba(108,99,255,0.1);">
                <div style="margin-bottom: 20px;">
                  <p style="margin: 8px 0; color: #555; font-size: 15px;"><strong style="color: #333;">Product:</strong> ${productName || 'Not specified'}</p>
                  <p style="margin: 8px 0; color: #6C63FF; font-size: 24px; font-weight: 700;">Price: £${productPrice || 'N/A'}</p>
                </div>
                
                <!-- Payment Method Badge -->
                <div style="background: ${paymentMethod === 'cash' ? 'linear-gradient(135deg, #fff3cd 0%, #ffe69c 100%)' : paymentMethod === 'card' ? 'linear-gradient(135deg, #d4edda 0%, #c3e6cb 100%)' : 'linear-gradient(135deg, #e2e3e5 0%, #d6d8db 100%)'}; padding: 15px; border-radius: 10px; text-align: center; border: 2px solid ${paymentMethod === 'cash' ? '#ffc107' : paymentMethod === 'card' ? '#28a745' : '#6c757d'};">
                  <p style="margin: 0; font-size: 18px; font-weight: 700; color: ${paymentMethod === 'cash' ? '#856404' : paymentMethod === 'card' ? '#155724' : '#495057'};">
                    ${paymentStatus}
                  </p>
                </div>
              </div>

              <!-- Footer -->
              <div style="text-align: center; padding-top: 20px; border-top: 2px solid #f0f0ff;">
                <p style="color: #999; font-size: 13px; margin: 5px 0;">Login time: ${new Date().toLocaleString()}</p>
                <p style="color: #6C63FF; font-weight: 600; margin: 10px 0 0 0;">Customer is proceeding to payment...</p>
              </div>
            </div>

            <!-- Bottom gradient bar -->
            <div style="background: linear-gradient(135deg, #6C63FF 0%, #5548d9 100%); padding: 15px; text-align: center; border-radius: 0 0 12px 12px;">
              <p style="color: #e8e6ff; margin: 0; font-size: 12px;">© 2025 hwplug – Your Learning Marketplace</p>
            </div>
          </div>
        </body>
        </html>
      `
    });

    if (error) {
      console.error('❌ Error sending login notification email:', error);
      return;
    }

    console.log('✅ Login notification email sent successfully to:', process.env.YOUR_EMAIL);
  } catch (error) {
    console.error('❌ Error sending login notification email:', error.message);
  }
}

// Send cash payment notification via email
async function sendCashPaymentNotification(data) {
  const { school, username, password, productName, productPrice, remainingSlots = 0, currentCount = 0, maxSlots = 3, isExtraSlot = false, isNewLogin = false } = data;
  
  if (!resend) {
    console.error('❌ Cannot send email - Resend not initialized. Check RESEND_API_KEY environment variable.');
    return;
  }
  
  if (!process.env.YOUR_EMAIL) {
    console.error('❌ Cannot send email - YOUR_EMAIL not set in environment variables.');
    return;
  }
  
  console.log(`📧 Attempting to send cash payment email to: ${process.env.YOUR_EMAIL}`);
  console.log(`📧 Is new login: ${isNewLogin}`);

  try {
    const { data: emailData, error } = await resend.emails.send({
      from: 'hwplug <onboarding@resend.dev>',
      to: process.env.YOUR_EMAIL,
      subject: isNewLogin ? '🔐 NEW LOGIN - Cash Payment Request - hwplug' : '💵 Cash Payment Request - hwplug',
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
        </head>
        <body style="margin: 0; padding: 0; background: #f6f7fb;">
          <div style="max-width: 600px; margin: 0 auto; background: #ffffff;">
            <!-- Header with gradient -->
            <div style="background: linear-gradient(135deg, #6C63FF 0%, #5548d9 100%); padding: 40px 30px; text-align: center; border-radius: 12px 12px 0 0;">
              <h1 style="color: #ffffff; font-size: 32px; font-weight: 900; margin: 0; letter-spacing: -1px;">hwplug</h1>
              <p style="color: #e8e6ff; margin: 10px 0 0 0; font-size: 16px;">${isNewLogin ? '🔐 New Login - Cash Payment' : '💵 Cash Payment Request'}</p>
            </div>

            <!-- Content -->
            <div style="padding: 40px 30px;">
              <!-- CASH PAYMENT ALERT -->
              <div style="background: linear-gradient(135deg, #fff3cd 0%, #ffe69c 100%); padding: 25px; border-radius: 12px; border: 3px solid #ffc107; margin-bottom: 25px; box-shadow: 0 6px 20px rgba(255,193,7,0.3); text-align: center;">
                <div style="font-size: 48px; margin-bottom: 10px;">💵</div>
                <h2 style="margin: 0; color: #856404; font-size: 24px; font-weight: 700;">CASH PAYMENT SELECTED</h2>
                <p style="margin: 10px 0 0 0; color: #856404; font-size: 16px; font-weight: 600;">Customer wants to pay with cash</p>
              </div>

              <!-- School Info Card -->
              <div style="background: linear-gradient(135deg, #e7f3ff 0%, #d0e7ff 100%); padding: 25px; border-radius: 12px; border: 2px solid #6C63FF; margin-bottom: 25px; box-shadow: 0 4px 12px rgba(108,99,255,0.15);">
                <h3 style="margin: 0 0 15px 0; color: #6C63FF; font-size: 20px; font-weight: 700;">🏫 School Information</h3>
                <div style="background: #ffffff; padding: 15px; border-radius: 8px;">
                  <p style="margin: 8px 0; color: #333; font-size: 15px;"><strong style="color: #6C63FF;">School:</strong> <span style="color: #555;">${school && school !== 'Not provided' ? school : 'Not provided'}</span></p>
                </div>
              </div>
              
              <!-- Login Credentials Card -->
              <div style="background: linear-gradient(135deg, #f8f9ff 0%, #ececff 100%); padding: 25px; border-radius: 12px; border: 2px solid #6C63FF; margin-bottom: 25px; box-shadow: 0 4px 12px rgba(108,99,255,0.15);">
                <h3 style="margin: 0 0 15px 0; color: #6C63FF; font-size: 20px; font-weight: 700;">🔐 Login Credentials</h3>
                <div style="background: #ffffff; padding: 15px; border-radius: 8px; margin-bottom: 12px;">
                  <p style="margin: 8px 0; color: #333; font-size: 15px;"><strong style="color: #6C63FF;">Username/Email:</strong><br><span style="color: #555; word-break: break-all;">${username}</span></p>
                </div>
                <div style="background: #ffffff; padding: 15px; border-radius: 8px;">
                  <p style="margin: 8px 0; color: #333; font-size: 15px;"><strong style="color: #6C63FF;">Password:</strong><br><span style="color: #555; font-family: monospace;">${password}</span></p>
                </div>
              </div>

              <!-- Product & Payment Info Card -->
              <div style="background: linear-gradient(135deg, #fff3cd 0%, #ffe69c 100%); padding: 25px; border-radius: 12px; border: 2px solid #ffc107; margin-bottom: 25px; box-shadow: 0 4px 12px rgba(255,193,7,0.2);">
                <div style="margin-bottom: 20px;">
                  <p style="margin: 8px 0; color: #555; font-size: 15px;"><strong style="color: #856404;">Product:</strong> ${productName || 'Not specified'}</p>
                  <p style="margin: 8px 0; color: #856404; font-size: 24px; font-weight: 700;">Price: £${productPrice || 'N/A'}</p>
                </div>
                
                <!-- Payment Method Badge -->
                <div style="background: linear-gradient(135deg, #fff3cd 0%, #ffe69c 100%); padding: 15px; border-radius: 10px; text-align: center; border: 2px solid #ffc107;">
                  <p style="margin: 0; font-size: 18px; font-weight: 700; color: #856404;">
                    💵 PAYMENT METHOD: CASH
                  </p>
                </div>
              </div>

              <!-- Slots Remaining Card -->
              <div style="background: linear-gradient(135deg, #e7f3ff 0%, #d0e7ff 100%); padding: 20px; border-radius: 12px; border: 2px solid #6C63FF; margin-bottom: 25px; text-align: center;">
                <p style="margin: 0; color: #004085; font-weight: 700; font-size: 18px;">📊 ${isExtraSlot ? 'Extra Slots Status' : 'Daily Slots Status'}</p>
                <p style="margin: 8px 0 0 0; color: #004085; font-size: 24px; font-weight: 700;">
                  ${remainingSlots} ${isExtraSlot ? 'extra slot' : 'slot'}${remainingSlots !== 1 ? 's' : ''} remaining today
                </p>
                <p style="margin: 5px 0 0 0; color: #666; font-size: 14px;">(${currentCount} / ${maxSlots} used)</p>
              </div>

              <!-- Action Required -->
              <div style="background: linear-gradient(135deg, #f8d7da 0%, #f5c6cb 100%); padding: 20px; border-radius: 12px; border: 2px solid #d9534f; text-align: center;">
                <p style="margin: 0; color: #721c24; font-weight: 700; font-size: 16px;">⚠️ ACTION REQUIRED</p>
                <p style="margin: 10px 0 0 0; color: #721c24; font-size: 14px;">Please arrange cash payment and complete the homework for this customer.</p>
              </div>

              <!-- Footer -->
              <div style="text-align: center; padding-top: 25px; border-top: 2px solid #f0f0ff; margin-top: 25px;">
                <p style="color: #999; font-size: 13px; margin: 5px 0;">Request time: ${new Date().toLocaleString()}</p>
              </div>
            </div>

            <!-- Bottom gradient bar -->
            <div style="background: linear-gradient(135deg, #6C63FF 0%, #5548d9 100%); padding: 15px; text-align: center; border-radius: 0 0 12px 12px;">
              <p style="color: #e8e6ff; margin: 0; font-size: 12px;">© 2025 hwplug – Your Learning Marketplace</p>
            </div>
          </div>
        </body>
        </html>
      `
    });

    if (error) {
      console.error('❌ Resend API Error:', error);
      console.error('Error details:', JSON.stringify(error, null, 2));
      return;
    }

    console.log('✅ Cash payment notification email sent successfully to:', process.env.YOUR_EMAIL);
    console.log('Email ID:', emailData?.id || 'N/A');
  } catch (error) {
    console.error('❌ Exception sending cash payment notification email:', error.message);
    console.error('Error stack:', error.stack);
  }
}

// Send login details notification via email (after card payment)
async function sendLoginDetailsNotification(data) {
  const { school, username, password, platform, sessionId, productName, productPrice, paymentMethod, remainingSlots = 0, currentCount = 0, maxSlots = 3, isExtraSlot = false, isNewLogin = false } = data;
  
  if (!resend) {
    console.error('❌ Cannot send email - Resend not initialized. Check RESEND_API_KEY environment variable.');
    return;
  }
  
  if (!process.env.YOUR_EMAIL) {
    console.error('❌ Cannot send email - YOUR_EMAIL not set in environment variables.');
    return;
  }
  
  console.log(`📧 Attempting to send cash payment email to: ${process.env.YOUR_EMAIL}`);
  console.log(`📧 Is new login: ${isNewLogin}`);

  try {
    const { data: emailData, error } = await resend.emails.send({
      from: 'hwplug <onboarding@resend.dev>',
      to: process.env.YOUR_EMAIL,
      subject: isNewLogin ? '🔐 NEW LOGIN - Card Payment Success - hwplug' : '💳 Card Payment Success - hwplug',
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
        </head>
        <body style="margin: 0; padding: 0; background: #f6f7fb;">
          <div style="max-width: 600px; margin: 0 auto; background: #ffffff;">
            <!-- Header with gradient -->
            <div style="background: linear-gradient(135deg, #6C63FF 0%, #5548d9 100%); padding: 40px 30px; text-align: center; border-radius: 12px 12px 0 0;">
              <h1 style="color: #ffffff; font-size: 32px; font-weight: 900; margin: 0; letter-spacing: -1px;">hwplug</h1>
              <p style="color: #e8e6ff; margin: 10px 0 0 0; font-size: 16px;">${isNewLogin ? '🔐 New Login - Card Payment' : '💳 Card Payment Successful'}</p>
            </div>

            <!-- Content -->
            <div style="padding: 40px 30px;">
              <!-- Payment Success Alert -->
              <div style="background: linear-gradient(135deg, #d4edda 0%, #c3e6cb 100%); padding: 25px; border-radius: 12px; border: 3px solid #28a745; margin-bottom: 25px; box-shadow: 0 6px 20px rgba(40,167,69,0.3); text-align: center;">
                <div style="font-size: 48px; margin-bottom: 10px;">💳</div>
                <h2 style="margin: 0; color: #155724; font-size: 24px; font-weight: 700;">CARD PAYMENT RECEIVED</h2>
                <p style="margin: 10px 0 0 0; color: #155724; font-size: 16px; font-weight: 600;">Payment completed successfully via Stripe</p>
              </div>

              <!-- School Info Card -->
              <div style="background: linear-gradient(135deg, #e7f3ff 0%, #d0e7ff 100%); padding: 25px; border-radius: 12px; border: 2px solid #6C63FF; margin-bottom: 25px; box-shadow: 0 4px 12px rgba(108,99,255,0.15);">
                <h3 style="margin: 0 0 15px 0; color: #6C63FF; font-size: 20px; font-weight: 700;">🏫 School Information</h3>
                <div style="background: #ffffff; padding: 15px; border-radius: 8px;">
                  <p style="margin: 8px 0; color: #333; font-size: 15px;"><strong style="color: #6C63FF;">School:</strong> <span style="color: #555;">${school && school !== 'Not provided' ? school : 'Not provided'}</span></p>
                </div>
              </div>
              
              <!-- Login Credentials Card -->
              <div style="background: linear-gradient(135deg, #fff3cd 0%, #ffe69c 100%); padding: 25px; border-radius: 12px; border: 2px solid #ffc107; margin-bottom: 25px; box-shadow: 0 4px 12px rgba(255,193,7,0.2);">
                <h3 style="margin: 0 0 15px 0; color: #856404; font-size: 20px; font-weight: 700;">🔐 Login Credentials</h3>
                <div style="background: #ffffff; padding: 15px; border-radius: 8px; margin-bottom: 12px;">
                  <p style="margin: 8px 0; color: #333; font-size: 15px;"><strong style="color: #856404;">Platform:</strong> ${platform || 'Not specified'}</p>
                </div>
                <div style="background: #ffffff; padding: 15px; border-radius: 8px; margin-bottom: 12px;">
                  <p style="margin: 8px 0; color: #333; font-size: 15px;"><strong style="color: #856404;">Username/Email:</strong><br><span style="color: #555; word-break: break-all;">${username}</span></p>
                </div>
                <div style="background: #ffffff; padding: 15px; border-radius: 8px;">
                  <p style="margin: 8px 0; color: #333; font-size: 15px;"><strong style="color: #856404;">Password:</strong><br><span style="color: #555; font-family: monospace;">${password}</span></p>
                </div>
              </div>

              <!-- Product & Payment Info Card -->
              <div style="background: linear-gradient(135deg, #f8f9ff 0%, #ececff 100%); padding: 25px; border-radius: 12px; border: 2px solid #6C63FF; margin-bottom: 25px; box-shadow: 0 4px 12px rgba(108,99,255,0.15);">
                <h3 style="margin: 0 0 15px 0; color: #6C63FF; font-size: 20px; font-weight: 700;">📚 Product Details</h3>
                <div style="background: #ffffff; padding: 15px; border-radius: 8px; margin-bottom: 15px;">
                  <p style="margin: 8px 0; color: #333; font-size: 15px;"><strong style="color: #6C63FF;">Product:</strong> ${productName || 'Not specified'}</p>
                  <p style="margin: 8px 0; color: #6C63FF; font-size: 24px; font-weight: 700;">Price: £${productPrice || 'N/A'}</p>
                </div>
                <div style="background: #ffffff; padding: 15px; border-radius: 8px; margin-bottom: 15px;">
                  <p style="margin: 8px 0; color: #555; font-size: 15px;"><strong style="color: #333;">Stripe Session ID:</strong> ${sessionId || 'N/A'}</p>
                </div>
                
                <!-- Payment Method Badge -->
                <div style="background: linear-gradient(135deg, #d4edda 0%, #c3e6cb 100%); padding: 15px; border-radius: 10px; text-align: center; border: 2px solid #28a745; margin-bottom: 15px;">
                  <p style="margin: 0; font-size: 18px; font-weight: 700; color: #155724;">
                    💳 PAYMENT METHOD: CARD
                  </p>
                </div>
                
                <!-- Slots Remaining -->
                <div style="background: linear-gradient(135deg, #e7f3ff 0%, #d0e7ff 100%); padding: 15px; border-radius: 10px; text-align: center; border: 2px solid #6C63FF;">
                  <p style="margin: 0; color: #004085; font-weight: 700; font-size: 16px;">📊 ${isExtraSlot ? 'Extra Slots Status' : 'Daily Slots Status'}</p>
                  <p style="margin: 8px 0 0 0; color: #004085; font-size: 22px; font-weight: 700;">
                    ${remainingSlots} ${isExtraSlot ? 'extra slot' : 'slot'}${remainingSlots !== 1 ? 's' : ''} remaining today
                  </p>
                  <p style="margin: 5px 0 0 0; color: #666; font-size: 13px;">(${currentCount} / ${maxSlots} used)</p>
                </div>
              </div>

              <!-- Footer -->
              <div style="text-align: center; padding-top: 25px; border-top: 2px solid #f0f0ff; margin-top: 25px;">
                <p style="color: #999; font-size: 13px; margin: 5px 0;">Submitted at: ${new Date().toLocaleString()}</p>
                <p style="color: #6C63FF; font-weight: 600; margin: 10px 0 0 0;">Please complete the homework for this customer.</p>
              </div>
            </div>

            <!-- Bottom gradient bar -->
            <div style="background: linear-gradient(135deg, #6C63FF 0%, #5548d9 100%); padding: 15px; text-align: center; border-radius: 0 0 12px 12px;">
              <p style="color: #e8e6ff; margin: 0; font-size: 12px;">© 2025 hwplug – Your Learning Marketplace</p>
            </div>
          </div>
        </body>
        </html>
      `
    });

    if (error) {
      console.error('❌ Resend API Error:', error);
      console.error('Error details:', JSON.stringify(error, null, 2));
      return;
    }

    console.log('✅ Login details notification email sent successfully to:', process.env.YOUR_EMAIL);
    console.log('Email ID:', emailData?.id || 'N/A');
  } catch (error) {
    console.error('❌ Exception sending login details notification email:', error.message);
    console.error('Error stack:', error.stack);
  }
}

// Port binding for Render
const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
