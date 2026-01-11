require('dotenv').config();
const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { Resend } = require('resend');
const mongoose = require('mongoose');

const app = express();
app.use(cors());
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
  updatedAt: { type: Date, default: Date.now }
});

const DataModel = mongoose.model('Data', DataSchema);

// Daily purchase limit tracking (3 per product per day)
let dailyLimits = {
  'Sparx Reader': { count: 0, date: null, available: true },
  'Sparx Maths': { count: 0, date: null, available: true },
  'Educate': { count: 0, date: null, available: true },
  'Seneca': { count: 0, date: null, available: true }
};

const MAX_PURCHASES_PER_DAY = 3;
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
      dailyLimits = data.dailyLimits || dailyLimits;
      activeReservations = data.activeReservations || {};
      lastTimerResetTime = data.lastTimerResetTime || Date.now();
      loginHistory.push(...(data.loginHistory || []));
      cashPaymentCodes = data.cashPaymentCodes || [];
      codeUsageHistory = data.codeUsageHistory || [];
      availabilitySchedule = data.availabilitySchedule || availabilitySchedule;
      
      console.log('✅ Data loaded from MongoDB');
      console.log(`   - Last updated: ${data.updatedAt}`);
      console.log(`   - Login history entries: ${loginHistory.length}`);
      console.log(`   - Active reservations: ${Object.keys(activeReservations).length}`);
      console.log(`   - Cash payment codes: ${cashPaymentCodes.length}`);
      console.log(`   - Code usage history: ${codeUsageHistory.length}`);
      console.log(`   - Availability schedule:`, availabilitySchedule);
      console.log(`   - Slot counts:`, Object.entries(dailyLimits).map(([k, v]) => `${k}: ${v.count}`).join(', '));
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
      manuallyDisabled: true
    });
  }
  
  // Check if slots are full
  const available = product.count < MAX_PURCHASES_PER_DAY;
  const remaining = Math.max(0, MAX_PURCHASES_PER_DAY - product.count);
  
  res.json({
    available: available,
    remaining: remaining,
    count: product.count,
    max: MAX_PURCHASES_PER_DAY,
    manuallyDisabled: false
  });
});

// Reserve a slot (atomically check and increment) - prevents race conditions
app.post('/reserve-slot', (req, res) => {
  resetDailyCountersIfNeeded();
  const { productName } = req.body;
  
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
  
  // ATOMIC check and increment (prevents race condition)
  // This ensures only ONE person can reserve the last slot, even if multiple requests arrive simultaneously
  if (product.count >= MAX_PURCHASES_PER_DAY) {
    return res.json({ 
      success: false, 
      error: 'Slots are finished for today',
      remaining: 0,
      count: product.count
    });
  }
  
  // CRITICAL: Increment IMMEDIATELY before any other operation
  // This atomic operation ensures only one person gets the last slot
  const oldCount = product.count;
  product.count++;
  const remaining = MAX_PURCHASES_PER_DAY - product.count;
  
  // Create reservation ID and track it
  const reservationId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  activeReservations[reservationId] = {
    productName: productName,
    timestamp: Date.now()
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
    wasLastSlot: wasLastSlot
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
  
  // Release the slot by decrementing
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
      max: MAX_PURCHASES_PER_DAY
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
  
  if (newCount > MAX_PURCHASES_PER_DAY) {
    return res.status(400).json({ 
      error: `Slot count cannot exceed maximum (${MAX_PURCHASES_PER_DAY}). Change MAX_PURCHASES_PER_DAY if you need more slots.` 
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

// Admin endpoint to get current counter status
app.get('/admin/counters-status', (req, res) => {
  resetDailyCountersIfNeeded();
  res.json({
    success: true,
    counters: dailyLimits,
    maxPerDay: MAX_PURCHASES_PER_DAY
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
  
  console.log(`🧪 TEST TIMER SET: Will expire in ${minutes} minute(s) at ${new Date(expiresAt).toISOString()}`);
  
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
    
    // Check if date has actually changed (prevent multiple resets)
    let hasReset = false;
    let resetProducts = [];
    let skippedProducts = [];
    
    Object.keys(dailyLimits).forEach(product => {
      if (dailyLimits[product].date !== today) {
        // Only reset slots for products that are currently AVAILABLE
        if (dailyLimits[product].available) {
          dailyLimits[product].count = 0;
          dailyLimits[product].date = today;
          hasReset = true;
          resetProducts.push(product);
          console.log(`✅ Auto-reset: "${product}" slots reset to 0/${MAX_PURCHASES_PER_DAY} (AVAILABLE)`);
        } else {
          // Product is disabled - just update date but DON'T reset count
          dailyLimits[product].date = today;
          skippedProducts.push(product);
          console.log(`⏭️ Auto-reset: "${product}" DISABLED - slots NOT reset (keeping ${dailyLimits[product].count}/${MAX_PURCHASES_PER_DAY})`);
        }
      }
    });
    
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
      from: 'officialhwplug <onboarding@resend.dev>', // Update this to your verified domain
      to: process.env.YOUR_EMAIL,
      subject: '🧪 Test Email from officialhwplug Backend',
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

// Create Stripe Checkout Session
app.post('/create-checkout-session', async (req, res) => {
  try {
    const { items, customerEmail, homeworkEmail, homeworkPassword } = req.body;
    const total = items.reduce((sum, item) => sum + (item.price * item.qty), 0);
    const lineItems = items.map(item => ({
      price_data: {
        currency: 'gbp',
        product_data: {
          name: item.name,
        },
        unit_amount: item.price * 100,
      },
      quantity: item.qty,
    }));

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'payment',
      success_url: `${req.headers.origin}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${req.headers.origin}/cancel.html`,
      customer_email: customerEmail,
      metadata: {
        homeworkEmail: homeworkEmail,
        homeworkPassword: homeworkPassword,
        items: JSON.stringify(items)
      }
    });

    res.json({ id: session.id });
  } catch (error) {
    console.error('Error creating checkout session:', error);
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
    
    const { school, username, password, productName, productPrice, previousUsername, reservationId, cashCode } = req.body;
    
    console.log('💵 Extracted data:', { school, username, productName, productPrice, previousUsername, reservationId, cashCode, hasPassword: !!password });
    
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
      productName: productName || 'Unknown',
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
    if (productName && dailyLimits[productName]) {
      currentCount = dailyLimits[productName].count;
      remainingSlots = Math.max(0, MAX_PURCHASES_PER_DAY - currentCount);
      
      // Confirm the specific reservation if reservationId provided, otherwise confirm all for that product
      if (reservationId && activeReservations[reservationId]) {
        // Verify it's for the correct product
        if (activeReservations[reservationId].productName === productName) {
          delete activeReservations[reservationId];
          console.log(`✅ Reservation CONFIRMED (cash payment completed) for "${productName}" - Reservation ID: ${reservationId} - Count: ${currentCount}/${MAX_PURCHASES_PER_DAY} (${remainingSlots} remaining)`);
        } else {
          console.warn(`⚠️ Reservation ID ${reservationId} product mismatch. Confirming all reservations for ${productName}`);
          confirmReservation(productName);
        }
      } else {
        // No reservationId or not found - confirm all reservations for this product (fallback)
        console.log(`✅ Confirming all reservations for "${productName}" (no specific reservationId provided)`);
        confirmReservation(productName);
      }
      
      console.log(`✅ Product "${productName}" purchase count (slot already reserved): ${currentCount}/${MAX_PURCHASES_PER_DAY} (${remainingSlots} remaining)`);
    }
    
    // Send email notification for cash payment (non-blocking)
    console.log('📧 Attempting to send cash payment email...');
    sendCashPaymentNotification({
      school: school || 'Not provided',
      username,
      password,
      productName,
      productPrice,
      remainingSlots: remainingSlots,
      currentCount: currentCount,
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
      productName: productName || 'Unknown',
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
    
    const { school, username, password, platform, sessionId, productName, productPrice, paymentMethod, previousUsername, reservationId } = req.body;
    
    console.log('💳 Extracted data:', { 
      school, 
      username, 
      platform, 
      sessionId, 
      productName, 
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
    if (productName && dailyLimits[productName]) {
      currentCount = dailyLimits[productName].count;
      remainingSlots = Math.max(0, MAX_PURCHASES_PER_DAY - currentCount);
      
      // Confirm the specific reservation if reservationId provided, otherwise confirm all for that product
      if (reservationId && activeReservations[reservationId]) {
        // Verify it's for the correct product
        if (activeReservations[reservationId].productName === productName) {
          delete activeReservations[reservationId];
          console.log(`✅ Reservation CONFIRMED (card payment completed) for "${productName}" - Reservation ID: ${reservationId} - Count: ${currentCount}/${MAX_PURCHASES_PER_DAY} (${remainingSlots} remaining)`);
        } else {
          console.warn(`⚠️ Reservation ID ${reservationId} product mismatch. Confirming all reservations for ${productName}`);
          confirmReservation(productName);
        }
      } else {
        // No reservationId or not found - confirm all reservations for this product (fallback)
        console.log(`✅ Confirming all reservations for "${productName}" (no specific reservationId provided)`);
        confirmReservation(productName);
      }
      
      console.log(`✅ Product "${productName}" purchase count (slot already reserved): ${currentCount}/${MAX_PURCHASES_PER_DAY} (${remainingSlots} remaining)`);
    }
    
    // Send email notification with login details (CARD PAYMENT - only email sent for card)
    console.log('📧 Attempting to send card payment email...');
    await sendLoginDetailsNotification({
      school: school || 'Not provided',
      username,
      password,
      platform,
      sessionId,
      productName: productName || 'Unknown Product',
      productPrice: productPrice || 'N/A',
      paymentMethod: paymentMethod || 'card', // Default to card for this endpoint
      remainingSlots: remainingSlots,
      currentCount: currentCount,
      isNewLogin: isNewLogin
    });

    // Track login history
    loginHistory.push({
      username,
      school: school || 'Not provided',
      productName: productName || 'Unknown',
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
              <p style="color: #e8e6ff; margin: 0; font-size: 12px;">© 2025 officialhwplug – Your Learning Marketplace</p>
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
      subject: '🔐 New Customer Login - officialhwplug',
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
              <h1 style="color: #ffffff; font-size: 32px; font-weight: 900; margin: 0; letter-spacing: -1px;">officialhwplug</h1>
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
              <p style="color: #e8e6ff; margin: 0; font-size: 12px;">© 2025 officialhwplug – Your Learning Marketplace</p>
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
  const { school, username, password, productName, productPrice, remainingSlots = 0, currentCount = 0, isNewLogin = false } = data;
  
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
                <p style="margin: 0; color: #004085; font-weight: 700; font-size: 18px;">📊 Daily Slots Status</p>
                <p style="margin: 8px 0 0 0; color: #004085; font-size: 24px; font-weight: 700;">
                  ${remainingSlots} slot${remainingSlots !== 1 ? 's' : ''} remaining today
                </p>
                <p style="margin: 5px 0 0 0; color: #666; font-size: 14px;">(${currentCount} / ${MAX_PURCHASES_PER_DAY} used)</p>
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
              <p style="color: #e8e6ff; margin: 0; font-size: 12px;">© 2025 officialhwplug – Your Learning Marketplace</p>
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
  const { school, username, password, platform, sessionId, productName, productPrice, paymentMethod, remainingSlots = 0, currentCount = 0, isNewLogin = false } = data;
  
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
      subject: isNewLogin ? '🔐 NEW LOGIN - Card Payment Success - officialhwplug' : '💳 Card Payment Success - officialhwplug',
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
              <h1 style="color: #ffffff; font-size: 32px; font-weight: 900; margin: 0; letter-spacing: -1px;">officialhwplug</h1>
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
                  <p style="margin: 0; color: #004085; font-weight: 700; font-size: 16px;">📊 Daily Slots Status</p>
                  <p style="margin: 8px 0 0 0; color: #004085; font-size: 22px; font-weight: 700;">
                    ${remainingSlots} slot${remainingSlots !== 1 ? 's' : ''} remaining today
                  </p>
                  <p style="margin: 5px 0 0 0; color: #666; font-size: 13px;">(${currentCount} / ${MAX_PURCHASES_PER_DAY} used)</p>
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
              <p style="color: #e8e6ff; margin: 0; font-size: 12px;">© 2025 officialhwplug – Your Learning Marketplace</p>
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
