require('dotenv').config();
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

// Use stealth plugin to avoid detection
puppeteer.use(StealthPlugin());

// Track daily usage (reset at midnight)
let dailySubmissions = 0;
let lastResetDate = new Date().toDateString();

// Configuration
const CONFIG = {
  maxDailySlots: parseInt(process.env.MAX_DAILY_SLOTS) || 30, // Changed from 3 to 30 slots
  discordEmail: process.env.DISCORD_EMAIL || '',
  discordPassword: process.env.DISCORD_PASSWORD || '',
  channels: {
    'Sparx Maths': process.env.CHANNEL_SPARX_MATHS,
    'Sparx Reader': process.env.CHANNEL_SPARX_READER,
    'Educate': process.env.CHANNEL_EDUCATE,
    'Seneca': process.env.CHANNEL_SENECA
  }
};

let browser = null;
let page = null; // Main page (for Discord navigation and login checks)

/**
 * MULTI-TAB SYSTEM
 * ================
 * Each product gets its own dedicated browser tab for parallel processing.
 * 
 * How it works:
 * 1. Main tab (page): Used for Discord login and status checks
 * 2. Product tabs: Separate tabs for each product (Sparx Maths, Sparx Reader, Educate, Seneca)
 * 
 * Benefits:
 * - Multiple products can run simultaneously (e.g., Sparx Maths AND Sparx Reader at the same time)
 * - If the same product is requested again, it reuses its existing tab (no need to recreate)
 * - Each tab maintains its own state and position in Discord channels
 * - Busy flag prevents tab conflicts (only 1 job per product at a time)
 * 
 * Example:
 * - User 1 buys Sparx Reader → Opens Tab 1 for Sparx Reader
 * - User 2 buys Sparx Maths → Opens Tab 2 for Sparx Maths (runs in parallel!)
 * - User 3 buys Sparx Reader → Waits for Tab 1 to finish (tab is busy)
 */
const productTabs = {
  'Sparx Maths': { page: null, busy: false, lastUsed: null },
  'Sparx Reader': { page: null, busy: false, lastUsed: null },
  'Educate': { page: null, busy: false, lastUsed: null },
  'Seneca': { page: null, busy: false, lastUsed: null }
};

// Reset daily counter if new day
function checkDailyReset() {
  const today = new Date().toDateString();
  if (today !== lastResetDate) {
    console.log('🔄 New day detected - resetting daily submission count');
    dailySubmissions = 0;
    lastResetDate = today;
  }
}

// Check if we can submit more jobs today
function canSubmitJob() {
  checkDailyReset();
  return dailySubmissions < CONFIG.maxDailySlots;
}

// Get current status
function getStatus() {
  checkDailyReset();
  return {
    dailyLimit: CONFIG.maxDailySlots,
    used: dailySubmissions,
    remaining: CONFIG.maxDailySlots - dailySubmissions,
    resetTime: getNextResetTime()
  };
}

// Calculate when slots reset
function getNextResetTime() {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);
  return tomorrow.toISOString();
}

// Admin function to reset daily counter
function resetDailyCounter() {
  const oldCount = dailySubmissions;
  dailySubmissions = 0;
  lastResetDate = new Date().toDateString();
  console.log(`🔄 ADMIN: Bot counter manually reset: ${oldCount} → 0`);
  return {
    success: true,
    oldCount: oldCount,
    newCount: 0,
    maxSlots: CONFIG.maxDailySlots
  };
}

// Helper function: Check if Discord is logged in, auto-login if not
async function ensureDiscordLoggedIn() {
  if (!page) {
    console.log('⚠️ Page not initialized');
    return false;
  }
  
  const currentUrl = page.url();
  console.log(`🔍 Checking Discord login status - Current URL: ${currentUrl}`);
  
  // Check if we're at the login page
  if (currentUrl.includes('discord.com/login') || currentUrl.includes('discord.com/register')) {
    console.log('🔐 Discord NOT logged in - auto-logging in now...');
    
    try {
      // Wait for email input
      await page.waitForSelector('input[name="email"]', { timeout: 10000 });
      console.log('✅ Found email input');
      
      // Clear and fill in email
      await page.click('input[name="email"]', { clickCount: 3 });
      await page.keyboard.press('Backspace');
      await page.type('input[name="email"]', CONFIG.discordEmail, { delay: 50 });
      console.log('✅ Email entered');
      
      // Clear and fill in password
      await page.click('input[name="password"]', { clickCount: 3 });
      await page.keyboard.press('Backspace');
      await page.type('input[name="password"]', CONFIG.discordPassword, { delay: 50 });
      console.log('✅ Password entered');
      
      // Click login button
      await page.click('button[type="submit"]');
      console.log('✅ Login button clicked');
      
      // Wait for login to complete (URL will change from /login)
      console.log('⏳ Waiting 1-2 minutes for Discord to log in and load...');
      
      // Wait for URL to change away from login page
      await page.waitForFunction(
        () => !window.location.href.includes('/login') && !window.location.href.includes('/register'),
        { timeout: 120000 } // 2 minutes
      );
      console.log('✅ Login page navigation completed!');
      
      // Give Discord time to fully load the app
      console.log('⏳ Waiting for Discord app to fully load...');
      await new Promise(resolve => setTimeout(resolve, 10000)); // Extra 10 seconds
      
      // Wait for app to be ready
      await page.waitForSelector('[class*="app"]', { timeout: 60000 });
      console.log('✅ Discord app loaded and ready!');
      
      return true;
    } catch (error) {
      console.error('❌ Auto-login failed:', error.message);
      return false;
    }
  } else {
    console.log('✅ Discord already logged in');
    return true;
  }
}

// Initialize browser
async function initBrowser() {
  if (browser) {
    console.log('✅ Browser already initialized');
    return;
  }

  console.log('🌐 Launching Chrome browser with multi-tab support...');
  console.log(`📺 DISPLAY environment: ${process.env.DISPLAY || 'NOT SET'}`);
  
  browser = await puppeteer.launch({
    headless: false, // Show browser so you can see what's happening
    defaultViewport: null,
    userDataDir: './chrome-data', // SAVE SESSIONS! Discord stays logged in!
    env: {
      ...process.env,
      DISPLAY: process.env.DISPLAY || ':99'
    },
    args: [
      '--start-maximized',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage'
    ]
  });

  page = await browser.newPage();
  
  // Set user agent to look like real browser
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  
  console.log('✅ Browser launched successfully!');
  console.log('📱 Opening Discord in main tab...');
  
  // Navigate to Discord
  await page.goto('https://discord.com/app', { waitUntil: 'domcontentloaded', timeout: 120000 });
  
  console.log('✅ Discord loaded!');
  
  // Wait a few seconds for any redirects (Discord might redirect to /login if session expired)
  console.log('⏳ Waiting 5 seconds for any redirects...');
  await new Promise(resolve => setTimeout(resolve, 5000));
  
  // Now check if we're at the login page
  const currentUrl = page.url();
  console.log(`📍 Current URL after waiting: ${currentUrl}`);
  
  if (currentUrl.includes('discord.com/login') || currentUrl.includes('discord.com/register')) {
    console.log('🔐 Discord login page detected - auto-logging in...');
    
    // Wait for email input
    await page.waitForSelector('input[name="email"]', { timeout: 10000 });
    console.log('✅ Found email input');
    
    // Fill in email
    await page.type('input[name="email"]', CONFIG.discordEmail, { delay: 50 });
    console.log('✅ Email entered');
    
    // Fill in password
    await page.type('input[name="password"]', CONFIG.discordPassword, { delay: 50 });
    console.log('✅ Password entered');
    
      // Click login button
      await page.click('button[type="submit"]');
      console.log('✅ Login button clicked');
      
      // Wait for login to complete (URL will change from /login)
      console.log('⏳ Waiting 1-2 minutes for Discord to log in and load...');
      
      // Wait for URL to change away from login page
      await page.waitForFunction(
        () => !window.location.href.includes('/login') && !window.location.href.includes('/register'),
        { timeout: 120000 } // 2 minutes
      );
      console.log('✅ Login page navigation completed!');
      
      // Give Discord extra time to fully load
      console.log('⏳ Giving Discord extra time to load...');
      await new Promise(resolve => setTimeout(resolve, 10000)); // 10 seconds
  } else {
    console.log('✅ Already logged into Discord (session saved)');
  }
  
  // Wait for Discord app to be ready (check for app-mount div which appears after login)
  console.log('⏳ Waiting for Discord app to load...');
  await page.waitForSelector('[class*="app"]', { timeout: 60000 });
  
  console.log('✅ Discord login detected!');
  console.log('🎯 Browser bot is now ready to automate submissions!');
  console.log('📑 Multi-tab system initialized - each product gets its own tab!');
  console.log('');
}

// Get or create a dedicated tab for a specific product
async function getProductTab(productName) {
  if (!productTabs[productName]) {
    throw new Error(`Unknown product: ${productName}`);
  }
  
  const tabInfo = productTabs[productName];
  
  // If tab doesn't exist yet, create it
  if (!tabInfo.page) {
    console.log(`📑 Creating new tab for "${productName}"...`);
    const newPage = await browser.newPage();
    await newPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    // Start navigation to Discord but DON'T WAIT for it to complete
    // This allows other tabs to be created in parallel!
    newPage.goto('https://discord.com/app', { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(err => {
      console.error(`⚠️ Tab navigation error for ${productName}:`, err.message);
    });
    console.log(`✅ Tab created for "${productName}" (loading in background...)`);
    
    tabInfo.page = newPage;
  } else {
    console.log(`♻️ Reusing existing tab for "${productName}"`);
  }
  
  tabInfo.lastUsed = Date.now();
  return tabInfo.page;
}

// Mark a product tab as busy or free
function setTabBusy(productName, isBusy) {
  if (productTabs[productName]) {
    productTabs[productName].busy = isBusy;
    console.log(`🔒 Tab for "${productName}" is now ${isBusy ? 'BUSY' : 'FREE'}`);
  }
}

// Check if a product tab is busy
function isTabBusy(productName) {
  return productTabs[productName] ? productTabs[productName].busy : false;
}

// Get status of all tabs
function getTabsStatus() {
  const status = {};
  Object.keys(productTabs).forEach(product => {
    const tab = productTabs[product];
    status[product] = {
      exists: tab.page !== null,
      busy: tab.busy,
      lastUsed: tab.lastUsed ? new Date(tab.lastUsed).toISOString() : null
    };
  });
  return status;
}

// Main function: Submit homework to SparxNow (with retry logic for detached frames)
async function submitToSparxNow(productName, username, password, school = '') {
  const MAX_RETRIES = 2;
  let lastError = null;
  
  // Check if this product's tab is currently busy
  if (isTabBusy(productName)) {
    console.log(`⚠️ Tab for "${productName}" is currently busy with another job!`);
    return {
      success: false,
      error: `Tab for ${productName} is busy. Please wait and try again.`
    };
  }
  
  // Mark tab as busy
  setTabBusy(productName, true);
  
  try {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        console.log('\n' + '='.repeat(60));
        console.log(`🚀 SUBMISSION ATTEMPT ${attempt}/${MAX_RETRIES} for "${productName}"`);
        console.log('='.repeat(60));
        
        const result = await submitToSparxNowInternal(productName, username, password, school);
        
        // Check if the result indicates failure (Internal function returns {success: false} instead of throwing)
        if (result.success === false) {
          throw new Error(result.error || 'Submission failed');
        }
        
        console.log(`\n✅ SUBMISSION SUCCESSFUL ON ATTEMPT ${attempt} for "${productName}"!\n`);
        return result;
        
      } catch (error) {
        lastError = error;
        const errorMsg = error.message || String(error);
        
        console.log(`\n❌ ATTEMPT ${attempt} FAILED for "${productName}": ${errorMsg}\n`);
        
        // Check if it's a retryable error (detached frame, connection closed, etc.)
        if (errorMsg.includes('detached Frame') || 
            errorMsg.includes('Execution context was destroyed') ||
            errorMsg.includes('Protocol error') ||
            errorMsg.includes('Connection closed') ||
            errorMsg.includes('Target closed')) {
          
          if (attempt < MAX_RETRIES) {
            const waitTime = 3000;
            console.log(`⏳ ${errorMsg.includes('Connection closed') ? 'Browser connection lost' : 'Detached frame detected'}. Waiting ${waitTime/1000}s before retry...\n`);
            
            // If connection closed or target closed, recreate this product's tab
            if (errorMsg.includes('Connection closed') || errorMsg.includes('Target closed')) {
              console.log(`🔄 Recreating tab for "${productName}"...\n`);
              try {
                if (productTabs[productName].page) {
                  await productTabs[productName].page.close();
                }
              } catch (e) {
                // Tab already closed, that's fine
              }
              productTabs[productName].page = null;
              
              // If main page is also dead, reinitialize entire browser
              if (!page || page.isClosed()) {
                console.log('🔄 Main page also dead - reinitializing entire browser...\n');
                try {
                  if (browser) {
                    await browser.close();
                  }
                } catch (e) {
                  // Browser already closed, that's fine
                }
                browser = null;
                page = null;
              }
            }
            
            await new Promise(resolve => setTimeout(resolve, waitTime));
          } else {
            console.log(`❌ All ${MAX_RETRIES} attempts failed for "${productName}".\n`);
          }
        } else {
          // Non-retryable error, throw immediately
          console.log(`❌ Non-retryable error for "${productName}". Stopping attempts.\n`);
          throw error;
        }
      }
    }
    
    // All retries exhausted
    console.log(`❌ SUBMISSION FAILED AFTER ${MAX_RETRIES} ATTEMPTS for "${productName}"\n`);
    throw lastError;
  } finally {
    // Always mark tab as free when done (success or failure)
    setTabBusy(productName, false);
    console.log(`🔓 Tab for "${productName}" is now FREE\n`);
  }
}

// Internal submission function (can retry if frame detaches)
async function submitToSparxNowInternal(productName, username, password, school = '') {
  console.log(`\n📋 Attempting to submit job for: ${productName}`);
  console.log(`📧 Username: ${username}`);
  console.log(`🏫 School: ${school || '(not provided)'}`);
  
  // Check daily limit
  if (!canSubmitJob()) {
    console.log(`❌ Daily limit reached (${dailySubmissions}/${CONFIG.maxDailySlots})`);
    return {
      success: false,
      error: 'Daily submission limit reached',
      remainingSlots: 0,
      usedSlots: dailySubmissions,
      maxSlots: CONFIG.maxDailySlots
    };
  }
  
  // Get the correct channel ID
  const channelId = CONFIG.channels[productName];
  if (!channelId) {
    console.log(`❌ Unknown product: ${productName}`);
    return {
      success: false,
      error: 'Unknown product'
    };
  }
  
  try {
    // Make sure browser is initialized
    if (!browser || !page) {
      await initBrowser();
    }
    
    // Get or create the product-specific tab
    console.log(`📑 Getting dedicated tab for "${productName}"...`);
    const productPage = await getProductTab(productName);
    
    // Check if product page is still valid before navigation
    try {
      await productPage.evaluate(() => true);
    } catch (e) {
      // Page is detached, recreate it
      console.log(`⚠️ Tab for "${productName}" was detached, recreating...`);
      try {
        await productPage.close();
      } catch (closeErr) {
        // Already closed
      }
      productTabs[productName].page = null;
      const productPage = await getProductTab(productName);
    }
    
    // Wait a bit for the tab to finish loading Discord (if it's a new tab)
    console.log(`⏳ Waiting for Discord to load in "${productName}" tab...`);
    try {
      await productPage.waitForSelector('[class*="app"]', { timeout: 30000 });
      console.log(`✅ Discord loaded in "${productName}" tab`);
    } catch (e) {
      console.log(`⚠️ Discord app selector not found, continuing anyway...`);
    }
    
    console.log(`🔍 Navigating "${productName}" tab to channel...`);
    
    // Navigate to the specific channel in the product-specific tab
    const channelUrl = `https://discord.com/channels/${process.env.SPARXNOW_SERVER_ID}/${channelId}`;
    await productPage.goto(channelUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    
    console.log('✅ Channel loaded in product tab');
    console.log('⏳ Waiting 10 seconds for Discord messages to fully load...');
    
    // Wait for messages to load (increased from 2s to 10s)
    await new Promise(resolve => setTimeout(resolve, 10000));
    
    console.log('🔍 Looking for SparxNow message with Login button...');
    
    // Find the Login button (look for button with text containing "Login")
    // Discord buttons are typically in a div with role="button"
    const loginButtonFound = await productPage.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('[role="button"]'));
      const loginButton = buttons.find(btn => 
        btn.textContent.includes('🔐') && btn.textContent.includes('Login')
      );
      
      if (loginButton) {
        loginButton.click();
        return true;
      }
      return false;
    });
    
    if (!loginButtonFound) {
      throw new Error('Could not find Login button in channel');
    }
    
    console.log('✅ Found and clicked Login button!');
    console.log('⏳ Waiting for login options to appear...');
    
    // Wait for the new buttons to appear
    await new Promise(resolve => setTimeout(resolve, 4000));
    
    // Check if this is Seneca (different flow - no "Login with Cookies")
    if (productName.toLowerCase().includes('seneca')) {
      console.log('🎓 Seneca detected - looking for Login button next to Saved Accounts...');
      
      const senecaLoginClicked = await productPage.evaluate(() => {
        console.log('=== SENECA LOGIN BUTTON SEARCH ===');
        
        const allButtons = Array.from(document.querySelectorAll('button, [role="button"]'));
        console.log(`Total buttons found: ${allButtons.length}`);
        
        // Log all button texts for debugging
        allButtons.forEach((btn, i) => {
          const text = btn.textContent?.trim() || '';
          if (text.length < 50) {
            console.log(`  [${i}] "${text}"`);
          }
        });
        
        // Strategy: Find "Saved Accounts" button, then click the button to its LEFT (Login)
        let savedAccountsIndex = -1;
        allButtons.forEach((btn, i) => {
          const text = btn.textContent?.trim() || '';
          if (text.includes('Saved Accounts') || (text.includes('Saved') && text.includes('Account'))) {
            console.log(`✅ Found "Saved Accounts" at index ${i}`);
            savedAccountsIndex = i;
          }
        });
        
        if (savedAccountsIndex === -1) {
          console.log('❌ Could not find "Saved Accounts" button');
          return false;
        }
        
        // Click the button BEFORE "Saved Accounts" (to the left)
        if (savedAccountsIndex > 0) {
          const loginButton = allButtons[savedAccountsIndex - 1];
          const loginText = loginButton.textContent?.trim() || '';
          
          console.log(`✅ Button to the LEFT of "Saved Accounts": "${loginText}"`);
          
          // Verify it says "Login"
          if (loginText.includes('Login') || loginText.includes('🔒')) {
            console.log('✅ Clicking Login button next to Saved Accounts!');
            loginButton.scrollIntoView({ behavior: 'smooth', block: 'center' });
            loginButton.click();
            loginButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
            return true;
          } else {
            console.log('❌ Button to the left is not "Login", it says:', loginText);
          }
        }
        
        console.log('❌ Could not find Login button to the left of Saved Accounts');
        return false;
      });
      
      if (!senecaLoginClicked) {
        throw new Error('Could not find Seneca Login button next to Saved Accounts');
      }
      
      console.log('✅ Clicked Seneca Login button (next to Saved Accounts)!');
      console.log('⏳ Waiting for modal to appear...');
      
      // Wait for modal to appear
      await new Promise(resolve => setTimeout(resolve, 4000));
      
      // SENECA: Select Google from dropdown FIRST (EXACT same method as Sparx Maths!)
      console.log('📋 Step 1: Selecting Login Type: Google FIRST...');
      console.log('⚠️ Selecting dropdown first to prevent field clearing');
      
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Step 1: Click the dropdown to open it
      console.log('🖱️ Step 1: Clicking Login Type dropdown...');
      const dropdownClicked = await productPage.evaluate(() => {
        console.log('=== DROPDOWN SEARCH ===');
        
        // Find ALL elements that might be the dropdown
        const allElements = Array.from(document.querySelectorAll('*'));
        
        // Look for elements with "Normal/Microsoft/Google" text
        const candidates = allElements.filter(el => {
          const text = el.textContent?.trim() || '';
          return text.includes('Normal') && text.includes('Microsoft') && text.includes('Google');
        });
        
        console.log(`Found ${candidates.length} elements with dropdown text`);
        
        candidates.forEach((el, i) => {
          const text = el.textContent?.trim();
          console.log(`  [${i}] "${text}" - tag: ${el.tagName}, clickable: ${!!el.onclick}`);
        });
        
        // Find the SHORTEST one (the actual button, not a parent container)
        const dropdown = candidates.sort((a, b) => {
          const aText = a.textContent?.trim().length || 9999;
          const bText = b.textContent?.trim().length || 9999;
          return aText - bText;
        })[0];
        
        if (dropdown) {
          const text = dropdown.textContent?.trim();
          console.log(`✅ Selected shortest match: "${text}"`);
          console.log(`   Tag: ${dropdown.tagName}, ID: ${dropdown.id}, Class: ${dropdown.className}`);
          
          // Scroll into view
          dropdown.scrollIntoView({ behavior: 'smooth', block: 'center' });
          console.log('📜 Scrolled into view');
          
          // Try multiple click methods
          console.log('🖱️ Attempting click method 1: element.click()');
          dropdown.click();
          
          console.log('🖱️ Attempting click method 2: dispatchEvent');
          dropdown.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
          
          console.log('🖱️ Attempting click method 3: mousedown + mouseup');
          dropdown.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
          dropdown.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
          
          console.log('✅ Tried all click methods!');
          return true;
        }
        
        console.log('❌ Could not find dropdown button');
        return false;
      });
      
      if (!dropdownClicked) {
        console.log('❌ DROPDOWN NOT CLICKED! This is the problem!');
      } else {
        console.log('✅ Dropdown was clicked successfully!');
      }
      
      // Try Puppeteer's native click as backup
      console.log('🖱️ Also trying Puppeteer native click...');
      try {
        // Find the dropdown element and click with Puppeteer
        const dropdownElement = await productPage.evaluateHandle(() => {
          const allElements = Array.from(document.querySelectorAll('*'));
          const candidates = allElements.filter(el => {
            const text = el.textContent?.trim() || '';
            return text.includes('Normal') && text.includes('Microsoft') && text.includes('Google');
          });
          return candidates.sort((a, b) => {
            const aText = a.textContent?.trim().length || 9999;
            const bText = b.textContent?.trim().length || 9999;
            return aText - bText;
          })[0];
        });
        
        if (dropdownElement) {
          await dropdownElement.asElement()?.click();
          console.log('✅ Puppeteer click executed!');
        }
      } catch (err) {
        console.log('⚠️ Puppeteer click failed:', err.message);
      }
      
      // Step 2: Wait for options to appear
      console.log('⏳ Waiting for dropdown options...');
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Take a screenshot to see what's happening
      await productPage.screenshot({ path: 'seneca-dropdown-debug.png' });
      console.log('📸 Screenshot saved: seneca-dropdown-debug.png');
      
      // Step 3: Click "Google" from the list
      console.log('🖱️ Step 2: Clicking "Google" option...');
      const googleClicked = await productPage.evaluate(() => {
        console.log('=== DROPDOWN DEBUG ===');
        
        // Find all elements with "Google", "Normal", or "Microsoft"
        const allElements = Array.from(document.querySelectorAll('*'));
        const optionLike = allElements.filter(el => {
          const text = el.textContent?.trim() || '';
          const isVisible = el.offsetHeight > 0 && el.offsetWidth > 0;
          const hasOptionText = text === 'Normal' || text === 'Microsoft' || text === 'Google';
          return hasOptionText && isVisible;
        });
        
        console.log('Found option elements:', optionLike.length);
        optionLike.forEach((el, i) => {
          console.log(`  [${i}] "${el.textContent?.trim()}" - tag: ${el.tagName}, clickable: ${el.onclick !== null}`);
        });
        
        // Try to find and click "Google"
        const googleOption = optionLike.find(el => el.textContent?.trim() === 'Google');
        
        if (googleOption) {
          console.log('✅ Found Google option!');
          console.log('Tag:', googleOption.tagName);
          console.log('Parent:', googleOption.parentElement?.tagName);
          googleOption.click();
          return true;
        }
        
        console.log('❌ Could not find Google option');
        return false;
      });
      
      if (googleClicked) {
        console.log('✅ Google selected by clicking!');
        await new Promise(resolve => setTimeout(resolve, 500));
      } else {
        console.log('⚠️ Could not click Google, trying keyboard navigation...');
        
        // Focus back on the dropdown first
        await productPage.evaluate(() => {
          const allElements = Array.from(document.querySelectorAll('*'));
          const dropdown = allElements.find(el => {
            const text = el.textContent?.trim() || '';
            return text === 'Normal/Microsoft/Google' || 
                   (text.includes('Normal') && text.includes('Microsoft') && text.includes('Google'));
          });
          if (dropdown) {
            console.log('🎯 Focusing dropdown for keyboard');
            dropdown.focus();
            dropdown.click(); // Click again to ensure it's open
          }
        });
        
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Now use keyboard (Down arrow x3 to get to Google, then Enter)
        console.log('⌨️ Pressing Arrow Down 3 times...');
        await productPage.keyboard.press('ArrowDown'); // Go to Normal
        await new Promise(resolve => setTimeout(resolve, 200));
        await productPage.keyboard.press('ArrowDown'); // Go to Microsoft
        await new Promise(resolve => setTimeout(resolve, 200));
        await productPage.keyboard.press('ArrowDown'); // Go to Google
        await new Promise(resolve => setTimeout(resolve, 200));
        console.log('⌨️ Pressing Enter...');
        await productPage.keyboard.press('Enter'); // Select Google
        
        console.log('✅ Selected Google using keyboard!');
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      
      // NOW fill form fields (NO SCHOOL for Seneca!)
      console.log('📝 NOW filling Seneca form fields (Email, Password - NO SCHOOL)...');
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Click Email field (input 0) and type
      console.log('📝 Filling Email field...');
      const senecaEmailClicked = await productPage.evaluate(() => {
        const inputs = Array.from(document.querySelectorAll('input'));
        if (inputs[0]) {
          inputs[0].value = '';
          inputs[0].click();
          inputs[0].focus();
          return true;
        }
        return false;
      });
      
      if (senecaEmailClicked) {
        await new Promise(resolve => setTimeout(resolve, 300));
        await productPage.keyboard.type(username, { delay: 30 });
        console.log('✅ Email typed:', username);
      }
      
      // Click Password field (input 1) and type
      console.log('📝 Filling Password field...');
      const senecaPasswordClicked = await productPage.evaluate(() => {
        const inputs = Array.from(document.querySelectorAll('input'));
        if (inputs[1]) {
          inputs[1].value = '';
          inputs[1].click();
          inputs[1].focus();
          return true;
        }
        return false;
      });
      
      if (senecaPasswordClicked) {
        await new Promise(resolve => setTimeout(resolve, 300));
        await productPage.keyboard.type(password, { delay: 30 });
        console.log('✅ Password typed');
      }
      
      await new Promise(resolve => setTimeout(resolve, 500));
      console.log('✅ Seneca form filled!');
      
      // Click Submit button
      console.log('🔘 Clicking Submit button...');
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      const senecaSubmitClicked = await productPage.evaluate(() => {
        console.log('🔍 Looking for Submit button...');
        const buttons = Array.from(document.querySelectorAll('button'));
        
        buttons.forEach((btn, i) => {
          const text = btn.textContent?.trim();
          console.log(`  [${i}] "${text}" (disabled: ${btn.disabled})`);
        });
        
        const submitButton = buttons.find(btn => {
          const text = btn.textContent?.toLowerCase().trim() || '';
          return text === 'submit' && !btn.disabled;
        });
        
        if (submitButton) {
          console.log('✅ Clicking Submit button!');
          submitButton.click();
          return true;
        }
        
        console.log('❌ Submit button not found');
        return false;
      });
      
      if (!senecaSubmitClicked) {
        throw new Error('Could not find or click Seneca Submit button');
      }
      
      console.log('✅ Seneca Submit button clicked!');
      
      // Take screenshot
      await productPage.screenshot({ path: 'seneca-submit-result.png' });
      console.log('📸 Screenshot saved: seneca-submit-result.png');
      
      // Skip the rest of the form filling for non-Seneca products
      
    } else {
      console.log('🔍 Looking for "Login with Cookies" button...');
      
      // Strategy: Find "Login with Cookies", then click the button to its LEFT
      const secondButtonClicked = await productPage.evaluate(() => {
        // Get ALL buttons on the page
        const allButtons = Array.from(document.querySelectorAll('button, [role="button"]'));
        
        console.log('Total buttons found:', allButtons.length);
        
        // Find the "Login with Cookies" button first
        let cookieButtonIndex = -1;
        allButtons.forEach((btn, i) => {
          const text = btn.textContent?.replace(/\s+/g, ' ').trim() || '';
          if (text.includes('Login with Cookies') || (text.includes('Cookie') && text.includes('Login'))) {
            console.log(`Found "Login with Cookies" at index ${i}`);
            cookieButtonIndex = i;
          }
        });
        
        if (cookieButtonIndex === -1) {
          console.log('❌ Could not find "Login with Cookies" button');
          return false;
        }
        
        // Now find the button BEFORE it (to the left)
        if (cookieButtonIndex > 0) {
          const targetButton = allButtons[cookieButtonIndex - 1];
          const targetText = targetButton.textContent?.replace(/\s+/g, ' ').trim() || '';
          
          console.log(`Button to the LEFT of "Login with Cookies": "${targetText}"`);
          
          // Verify it says "Login" (not "Check Queue" or something else)
          if (targetText.includes('Login')) {
            console.log('✅ Clicking the Login button to the left!');
            targetButton.click();
            return true;
          } else {
            console.log('❌ Button to the left is not "Login", it says:', targetText);
          }
        }
        
        console.log('❌ Could not find Login button to the left of cookies');
        return false;
      });
      
      if (!secondButtonClicked) {
        throw new Error('Could not find regular Login button next to Login with Cookies');
      }
      
      console.log('✅ Clicked regular Login button!');
      console.log('⏳ Waiting for modal to appear...');
    
      // Wait longer for modal to appear
      await new Promise(resolve => setTimeout(resolve, 4000));
    }
    
    // Skip form filling for Seneca (it handles login automatically)
    if (!productName.toLowerCase().includes('seneca')) {
      // FIRST: Select Google from dropdown (do this BEFORE filling fields!)
      console.log('📋 Step 1: Selecting Login Type: Google FIRST...');
      console.log('⚠️ Selecting dropdown first to prevent field clearing');
    
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Step 1: Click the dropdown to open it
    console.log('🖱️ Step 1: Clicking Login Type dropdown...');
    const dropdownClicked = await productPage.evaluate(() => {
      console.log('=== DROPDOWN SEARCH ===');
      
      // Find ALL elements that might be the dropdown
      const allElements = Array.from(document.querySelectorAll('*'));
      
      // Look for elements with "Normal/Microsoft/Google" text
      const candidates = allElements.filter(el => {
        const text = el.textContent?.trim() || '';
        return text.includes('Normal') && text.includes('Microsoft') && text.includes('Google');
      });
      
      console.log(`Found ${candidates.length} elements with dropdown text`);
      
      candidates.forEach((el, i) => {
        const text = el.textContent?.trim();
        console.log(`  [${i}] "${text}" - tag: ${el.tagName}, clickable: ${!!el.onclick}`);
      });
      
      // Find the SHORTEST one (the actual button, not a parent container)
      const dropdown = candidates.sort((a, b) => {
        const aText = a.textContent?.trim().length || 9999;
        const bText = b.textContent?.trim().length || 9999;
        return aText - bText;
      })[0];
      
      if (dropdown) {
        const text = dropdown.textContent?.trim();
        console.log(`✅ Selected shortest match: "${text}"`);
        console.log(`   Tag: ${dropdown.tagName}, ID: ${dropdown.id}, Class: ${dropdown.className}`);
        
        // Scroll into view
        dropdown.scrollIntoView({ behavior: 'smooth', block: 'center' });
        console.log('📜 Scrolled into view');
        
        // Try multiple click methods
        console.log('🖱️ Attempting click method 1: element.click()');
        dropdown.click();
        
        console.log('🖱️ Attempting click method 2: dispatchEvent');
        dropdown.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        
        console.log('🖱️ Attempting click method 3: mousedown + mouseup');
        dropdown.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
        dropdown.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
        
        console.log('✅ Tried all click methods!');
        return true;
      }
      
      console.log('❌ Could not find dropdown button');
      return false;
    });
    
    if (!dropdownClicked) {
      console.log('❌ DROPDOWN NOT CLICKED! This is the problem!');
    } else {
      console.log('✅ Dropdown was clicked successfully!');
    }
    
    // Try Puppeteer's native click as backup
    console.log('🖱️ Also trying Puppeteer native click...');
    try {
      // Find the dropdown element and click with Puppeteer
      const dropdownElement = await productPage.evaluateHandle(() => {
        const allElements = Array.from(document.querySelectorAll('*'));
        const candidates = allElements.filter(el => {
          const text = el.textContent?.trim() || '';
          return text.includes('Normal') && text.includes('Microsoft') && text.includes('Google');
        });
        return candidates.sort((a, b) => {
          const aText = a.textContent?.trim().length || 9999;
          const bText = b.textContent?.trim().length || 9999;
          return aText - bText;
        })[0];
      });
      
      if (dropdownElement) {
        await dropdownElement.asElement()?.click();
        console.log('✅ Puppeteer click executed!');
      }
    } catch (err) {
      console.log('⚠️ Puppeteer click failed:', err.message);
    }
    
    // Step 2: Wait for options to appear
    console.log('⏳ Waiting for dropdown options...');
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Take a screenshot to see what's happening
    await productPage.screenshot({ path: 'dropdown-debug.png' });
    console.log('📸 Screenshot saved: dropdown-debug.png');
    
    // Step 3: Click "Google" from the list
    console.log('🖱️ Step 2: Clicking "Google" option...');
    const googleClicked = await productPage.evaluate(() => {
      console.log('=== DROPDOWN DEBUG ===');
      
      // Find all elements with "Google", "Normal", or "Microsoft"
      const allElements = Array.from(document.querySelectorAll('*'));
      const optionLike = allElements.filter(el => {
        const text = el.textContent?.trim() || '';
        const isVisible = el.offsetHeight > 0 && el.offsetWidth > 0;
        const hasOptionText = text === 'Normal' || text === 'Microsoft' || text === 'Google';
        return hasOptionText && isVisible;
      });
      
      console.log('Found option elements:', optionLike.length);
      optionLike.forEach((el, i) => {
        console.log(`  [${i}] "${el.textContent?.trim()}" - tag: ${el.tagName}, clickable: ${el.onclick !== null}`);
      });
      
      // Try to find and click "Google"
      const googleOption = optionLike.find(el => el.textContent?.trim() === 'Google');
      
      if (googleOption) {
        console.log('✅ Found Google option!');
        console.log('Tag:', googleOption.tagName);
        console.log('Parent:', googleOption.parentElement?.tagName);
        googleOption.click();
        return true;
      }
      
      console.log('❌ Could not find Google option');
      return false;
    });
    
    if (googleClicked) {
      console.log('✅ Google selected by clicking!');
      await new Promise(resolve => setTimeout(resolve, 500));
    } else {
      console.log('⚠️ Could not click Google, trying keyboard navigation...');
      
      // Focus back on the dropdown first
      await productPage.evaluate(() => {
        const allElements = Array.from(document.querySelectorAll('*'));
        const dropdown = allElements.find(el => {
          const text = el.textContent?.trim() || '';
          return text === 'Normal/Microsoft/Google' || 
                 (text.includes('Normal') && text.includes('Microsoft') && text.includes('Google'));
        });
        if (dropdown) {
          console.log('🎯 Focusing dropdown for keyboard');
          dropdown.focus();
          dropdown.click(); // Click again to ensure it's open
        }
      });
      
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Now use keyboard (Down arrow x3 to get to Google, then Enter)
      console.log('⌨️ Pressing Arrow Down 3 times...');
      await productPage.keyboard.press('ArrowDown'); // Go to Normal
      await new Promise(resolve => setTimeout(resolve, 200));
      await productPage.keyboard.press('ArrowDown'); // Go to Microsoft
      await new Promise(resolve => setTimeout(resolve, 200));
      await productPage.keyboard.press('ArrowDown'); // Go to Google
      await new Promise(resolve => setTimeout(resolve, 200));
      console.log('⌨️ Pressing Enter...');
      await productPage.keyboard.press('Enter'); // Select Google
      
      console.log('✅ Selected Google using keyboard!');
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    // NOW fill the form fields using Puppeteer typing (AFTER Google is selected)
    console.log('📝 Step 2: NOW filling form fields by clicking each one...');
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Click School field (input 0) and type
    console.log('📝 Filling School field...');
    const schoolClicked = await productPage.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input'));
      if (inputs[0]) {
        inputs[0].value = ''; // Clear first
        inputs[0].click();
        inputs[0].focus();
        return true;
      }
      return false;
    });
    
    if (schoolClicked) {
      await new Promise(resolve => setTimeout(resolve, 300));
      await productPage.keyboard.type(school, { delay: 30 });
      console.log('✅ School typed:', school);
    }
    
    // Click Email field (input 1) and type
    console.log('📝 Filling Email field...');
    const emailClicked = await productPage.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input'));
      if (inputs[1]) {
        inputs[1].value = ''; // Clear first
        inputs[1].click();
        inputs[1].focus();
        return true;
      }
      return false;
    });
    
    if (emailClicked) {
      await new Promise(resolve => setTimeout(resolve, 300));
      await productPage.keyboard.type(username, { delay: 30 });
      console.log('✅ Email typed:', username);
    }
    
    // Click Password field (input 2) and type
    console.log('📝 Filling Password field...');
    const passwordClicked = await productPage.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input'));
      if (inputs[2]) {
        inputs[2].value = ''; // Clear first
        inputs[2].click();
        inputs[2].focus();
        return true;
      }
      return false;
    });
    
    if (passwordClicked) {
      await new Promise(resolve => setTimeout(resolve, 300));
      await productPage.keyboard.type(password, { delay: 30 });
      console.log('✅ Password typed');
    }
    
    await new Promise(resolve => setTimeout(resolve, 500));
    console.log('✅ All fields filled successfully!');
    
    console.log('🔘 Clicking Submit button...');
    
    // Wait a moment for dropdown selection to register
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // VERIFY all fields before submitting
    console.log('🔍 Verifying all fields are filled...');
    const fieldCheck = await productPage.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input'));
      console.log('=== FIELD VERIFICATION ===');
      inputs.forEach((inp, i) => {
        console.log(`Input ${i}: value="${inp.value}", type="${inp.type}"`);
      });
      
      // Check dropdown value
      const selects = Array.from(document.querySelectorAll('select'));
      const customDropdown = Array.from(document.querySelectorAll('*')).find(el => {
        const text = el.textContent?.trim() || '';
        return text.includes('Normal') || text.includes('Microsoft') || text.includes('Google');
      });
      
      if (customDropdown) {
        console.log('Dropdown text:', customDropdown.textContent?.trim());
      }
      
      return true;
    });
    
    // Click Submit button
    const submitClicked = await productPage.evaluate(() => {
      console.log('🔍 Looking for Submit button...');
      const buttons = Array.from(document.querySelectorAll('button'));
      console.log(`Found ${buttons.length} buttons`);
      
      buttons.forEach((btn, i) => {
        const text = btn.textContent?.trim();
        console.log(`  [${i}] "${text}" (disabled: ${btn.disabled})`);
      });
      
      const submitButton = buttons.find(btn => {
        const text = btn.textContent?.toLowerCase().trim() || '';
        return text === 'submit' && !btn.disabled;
      });
      
      if (submitButton) {
        console.log('✅ Clicking Submit button!');
        submitButton.click();
        return true;
      }
      
      console.log('❌ Submit button not found');
      return false;
    });
    
    if (!submitClicked) {
      throw new Error('Could not find or click Submit button');
    }
    
    console.log('✅ Submit button clicked!');
    console.log('⏳ Waiting for confirmation...');
    
    // Wait for submission to process
    await new Promise(resolve => setTimeout(resolve, 3000));
    
      // Take screenshot of result
      await productPage.screenshot({ path: 'submit-result.png' });
      console.log('📸 Screenshot saved: submit-result.png');
    } // End of non-Seneca form filling
    
    // Check for errors (applies to non-Seneca products only)
    if (!productName.toLowerCase().includes('seneca')) {
      console.log('🔍 Checking for errors...');
    const errorCheck = await productPage.evaluate(() => {
      // Check if modal is still open (indicates error)
      const modals = document.querySelectorAll('[role="dialog"], .modal');
      
      if (modals.length > 0) {
        console.log('⚠️ Modal still open, checking for error messages...');
        
        // Look for error text
        const allText = Array.from(document.querySelectorAll('*'))
          .map(el => el.textContent?.trim() || '')
          .filter(text => text.length > 5 && text.length < 100);
        
        // Check for common error patterns
        const errorMessages = allText.filter(text => 
          text.toLowerCase().includes('required') ||
          text.toLowerCase().includes('invalid') ||
          text.toLowerCase().includes('must') ||
          text.toLowerCase().includes('error')
        );
        
        if (errorMessages.length > 0) {
          console.log('❌ Errors found:', errorMessages);
          return { hasError: true, errors: errorMessages };
        }
        
        console.log('⚠️ Modal open but no error message found');
        return { hasError: true, errors: ['Form submission may have failed - modal still open'] };
      }
      
      console.log('✅ Modal closed - submission successful!');
      return { hasError: false };
    });
    
      // If there are errors, throw exception
      if (errorCheck.hasError) {
        const errorMsg = errorCheck.errors.join(', ');
        console.log('');
        console.log('═══════════════════════════════════════════════════════');
        console.log('❌ SUBMISSION FAILED!');
        console.log('═══════════════════════════════════════════════════════');
        console.log('Error:', errorMsg);
        console.log('');
        throw new Error(`Submission failed: ${errorMsg}`);
      }
      
      console.log('✅ Login form submitted! Modal closed.');
    } // End of non-Seneca error checking
    
    console.log('⏳ Waiting for SparxNow to log in...');
    console.log('💡 This can take up to 1 minute...');
    
    // Wait for SparxNow to process the login (can take up to 60 seconds)
    let loginSuccess = false;
    let attempts = 0;
    const maxAttempts = 30; // 30 attempts x 2 seconds = 60 seconds max
    
    while (!loginSuccess && attempts < maxAttempts) {
      attempts++;
      
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Check if "Welcome" message appears
      loginSuccess = await productPage.evaluate((productName) => {
        const allText = Array.from(document.querySelectorAll('*'))
          .map(el => el.textContent?.trim() || '');
        
        // Different success indicators for Seneca vs others
        let hasSuccess = false;
        
        if (productName.toLowerCase().includes('seneca')) {
          // For Seneca: look for "Login Successful" or homework list
          hasSuccess = allText.some(text => 
            text.includes('Login Successful') || 
            text.includes('Choose a homework') ||
            text.includes('Due')
          );
        } else {
          // For Sparx products: look for "Welcome" or "Autocompleter"
          hasSuccess = allText.some(text => 
            text.includes('Welcome,') || 
            text.includes('Autocompleter') ||
            text.includes('Choose a homework task')
          );
        }
        
        if (hasSuccess) {
          console.log('✅ Login successful - interface loaded!');
          return true;
        }
        
        // Check if still logging in
        const isLoggingIn = allText.some(text => 
          text.includes('Logging In') || 
          text.includes('Attempting to log in')
        );
        
        if (isLoggingIn) {
          console.log('⏳ Still logging in...');
        }
        
        return false;
      }, productName);
      
      if (loginSuccess) {
        console.log(`✅ Login completed in ${attempts * 2} seconds!`);
        break;
      }
      
      if (attempts % 5 === 0) {
        console.log(`⏳ Still waiting... (${attempts * 2}s elapsed)`);
      }
    }
    
    if (!loginSuccess) {
      throw new Error('Login timeout - SparxNow did not load after 60 seconds');
    }
    
    // Wait a bit more for interface to stabilize
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Take screenshot to see what's loaded
    await productPage.screenshot({ path: 'homework-interface.png' });
    console.log('📸 Screenshot saved: homework-interface.png');
    
    // Different flow based on product type
    if (productName.toLowerCase().includes('seneca')) {
      console.log('🎓 Detected Seneca - using Seneca workflow...');
      
      // Wait LONGER for homework selection screen to fully load
      console.log('⏳ Waiting for homework selection screen to fully load...');
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      // Take screenshot to see what's on screen
      await productPage.screenshot({ path: 'seneca-homework-screen.png' });
      console.log('📸 Screenshot saved: seneca-homework-screen.png');
      
      // Debug: Check what text is on the page
      await productPage.evaluate(() => {
        const allText = Array.from(document.querySelectorAll('*'))
          .map(el => el.textContent?.trim() || '')
          .filter(text => text.length > 5 && text.length < 100);
        
        const uniqueText = [...new Set(allText)];
        console.log('=== PAGE TEXT DEBUG ===');
        console.log('First 20 text items:', uniqueText.slice(0, 20));
      });
      
      // Click "Choose a homework" dropdown (EXACT same method as Sparx Maths!)
      console.log('📋 Looking for "Choose a homework" dropdown...');
      const dropdownClicked = await productPage.evaluate(() => {
        console.log('=== SENECA HOMEWORK DROPDOWN SEARCH ===');
        
        // Find ALL elements that might be the dropdown
        const allElements = Array.from(document.querySelectorAll('*'));
        
        // Look for elements with "Choose a homework" text
        const candidates = allElements.filter(el => {
          const text = el.textContent?.trim() || '';
          return text.includes('Choose a homework');
        });
        
        console.log(`Found ${candidates.length} elements with dropdown text`);
        
        candidates.forEach((el, i) => {
          const text = el.textContent?.trim();
          console.log(`  [${i}] "${text}" - tag: ${el.tagName}, clickable: ${!!el.onclick}`);
        });
        
        // Find the SHORTEST one (the actual button, not a parent container)
        const dropdown = candidates.sort((a, b) => {
          const aText = a.textContent?.trim().length || 9999;
          const bText = b.textContent?.trim().length || 9999;
          return aText - bText;
        })[0];
        
        if (dropdown) {
          const text = dropdown.textContent?.trim();
          console.log(`✅ Selected shortest match: "${text}"`);
          console.log(`   Tag: ${dropdown.tagName}, ID: ${dropdown.id}, Class: ${dropdown.className}`);
          
          // Scroll into view
          dropdown.scrollIntoView({ behavior: 'smooth', block: 'center' });
          console.log('📜 Scrolled into view');
          
          // Try multiple click methods (SAME as Sparx Maths!)
          console.log('🖱️ Attempting click method 1: element.click()');
          dropdown.click();
          
          console.log('🖱️ Attempting click method 2: dispatchEvent');
          dropdown.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
          
          console.log('🖱️ Attempting click method 3: mousedown + mouseup');
          dropdown.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
          dropdown.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
          
          console.log('✅ Tried all click methods!');
          return true;
        }
        
        console.log('❌ Could not find dropdown button');
        return false;
      });
      
      if (!dropdownClicked) {
        console.log('❌ DROPDOWN NOT CLICKED! This is the problem!');
      } else {
        console.log('✅ Dropdown was clicked successfully!');
      }
      
      // Try Puppeteer's native click as backup (SAME as Sparx Maths!)
      console.log('🖱️ Also trying Puppeteer native click...');
      try {
        // Find the dropdown element and click with Puppeteer
        const dropdownElement = await productPage.evaluateHandle(() => {
          const allElements = Array.from(document.querySelectorAll('*'));
          const candidates = allElements.filter(el => {
            const text = el.textContent?.trim() || '';
            return text.includes('Choose a homework');
          });
          return candidates.sort((a, b) => {
            const aText = a.textContent?.trim().length || 9999;
            const bText = b.textContent?.trim().length || 9999;
            return aText - bText;
          })[0];
        });
        
        if (dropdownElement) {
          await dropdownElement.asElement()?.click();
          console.log('✅ Puppeteer click executed!');
        }
      } catch (err) {
        console.log('⚠️ Puppeteer click failed:', err.message);
      }
      
      if (!dropdownClicked) {
        throw new Error('Could not find Seneca homework dropdown');
      }
      
      console.log('✅ Clicked homework dropdown!');
      
      // Wait LONGER for dropdown options to fully appear (same as Sparx Maths)
      console.log('⏳ Waiting for homework list to appear...');
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      // Select the TOP homework (SAME method as Sparx Maths - aggressive clicking!)
      console.log('📝 Selecting TOP homework (most recent)...');
      const homeworkSelected = await productPage.evaluate(() => {
        console.log('=== SENECA HOMEWORK SELECTION ===');
        
        // Find all homework options - they contain "Due"
        const allElements = Array.from(document.querySelectorAll('*'));
        const homeworkOptions = allElements.filter(el => {
          const text = el.textContent?.trim() || '';
          // Look for "Due" in the text (Seneca format)
          return text.includes('Due') && text.length > 10 && text.length < 300;
        });
        
        console.log(`Found ${homeworkOptions.length} homework options`);
        
        homeworkOptions.forEach((opt, i) => {
          const text = opt.textContent?.trim();
          console.log(`  [${i}] "${text.substring(0, 80)}" - tag: ${opt.tagName}`);
        });
        
        if (homeworkOptions.length > 0) {
          // Sort by text length to find the ACTUAL clickable element (shortest = most specific)
          const sortedHomework = homeworkOptions.sort((a, b) => {
            const aText = a.textContent?.trim().length || 9999;
            const bText = b.textContent?.trim().length || 9999;
            return aText - bText;
          });
          
          // The shortest one should be the actual clickable homework item
          const topHomework = sortedHomework[0];
          const homeworkText = topHomework.textContent?.trim();
          
          console.log(`✅ Selecting TOP homework (shortest element): ${homeworkText.substring(0, 80)}`);
          console.log(`   Tag: ${topHomework.tagName}, ID: ${topHomework.id}, Class: ${topHomework.className}`);
          
          // Scroll into view
          topHomework.scrollIntoView({ behavior: 'smooth', block: 'center' });
          console.log('📜 Scrolled into view');
          
          // Try MULTIPLE click methods (SAME as Google and Sparx Maths!)
          console.log('🖱️ Attempting click method 1: element.click()');
          topHomework.click();
          
          console.log('🖱️ Attempting click method 2: dispatchEvent');
          topHomework.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
          
          console.log('🖱️ Attempting click method 3: mousedown + mouseup');
          topHomework.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
          topHomework.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
          
          console.log('✅ Tried all click methods!');
          
          return { success: true, homework: homeworkText.substring(0, 80) };
        }
        
        console.log('❌ No homework options found');
        console.log('Available text on page (first 30):');
        const allText = allElements
          .map(el => el.textContent?.trim() || '')
          .filter(text => text.length > 5 && text.length < 100);
        const uniqueText = [...new Set(allText)];
        console.log(uniqueText.slice(0, 30));
        
        return { success: false, homework: 'Unknown' };
      });
      
      // Also try Puppeteer's native click as backup (SAME as Sparx Maths!)
      console.log('🖱️ Also trying Puppeteer native click on homework...');
      try {
        const homeworkElement = await productPage.evaluateHandle(() => {
          const allElements = Array.from(document.querySelectorAll('*'));
          const homeworkOptions = allElements.filter(el => {
            const text = el.textContent?.trim() || '';
            return text.includes('Due') && text.length > 10 && text.length < 300;
          });
          
          // Sort to get the shortest (most specific clickable element)
          const sortedHomework = homeworkOptions.sort((a, b) => {
            const aText = a.textContent?.trim().length || 9999;
            const bText = b.textContent?.trim().length || 9999;
            return aText - bText;
          });
          
          return sortedHomework[0]; // Shortest = most specific
        });
        
        if (homeworkElement) {
          await homeworkElement.asElement()?.click();
          console.log('✅ Puppeteer click executed on homework!');
        }
      } catch (err) {
        console.log('⚠️ Puppeteer click failed:', err.message);
      }
      
      // Wait a bit longer for the click to register
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      if (!homeworkSelected.success) {
        throw new Error('Could not find or select Seneca homework');
      }
      
      console.log(`✅ Selected homework: ${homeworkSelected.homework}`);
      console.log('✅ Seneca homework selected - submission complete!');
      await new Promise(resolve => setTimeout(resolve, 2000));
      
    } else if (productName.toLowerCase().includes('reader')) {
      console.log('📚 Detected Sparx Reader - looking for Start button...');
      
      // Wait a bit more for interface to load
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Click the green "Start" button
      console.log('🔘 Looking for Start button...');
      const startButtonClicked = await productPage.evaluate(() => {
        console.log('=== START BUTTON SEARCH ===');
        
        // Find the Start button
        const allButtons = Array.from(document.querySelectorAll('button'));
        const startButtons = allButtons.filter(btn => {
          const text = btn.textContent?.trim() || '';
          return text === 'Start' || text.includes('Start');
        });
        
        console.log(`Found ${startButtons.length} Start button candidates`);
        
        startButtons.forEach((btn, i) => {
          console.log(`  [${i}] "${btn.textContent?.trim()}" - class: ${btn.className}`);
        });
        
        if (startButtons.length > 0) {
          const startButton = startButtons[0];
          console.log('✅ Found Start button');
          
          // Scroll into view
          startButton.scrollIntoView({ behavior: 'smooth', block: 'center' });
          console.log('📜 Scrolled into view');
          
          // Try MULTIPLE click methods (SAME as Google!)
          console.log('🖱️ Attempting click method 1: element.click()');
          startButton.click();
          
          console.log('🖱️ Attempting click method 2: dispatchEvent');
          startButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
          
          console.log('🖱️ Attempting click method 3: mousedown + mouseup');
          startButton.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
          startButton.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
          
          console.log('✅ Tried all click methods!');
          return true;
        }
        
        console.log('❌ Start button not found');
        return false;
      });
      
      // Also try Puppeteer's native click as backup
      console.log('🖱️ Also trying Puppeteer native click...');
      try {
        const startButtonElement = await productPage.evaluateHandle(() => {
          const allButtons = Array.from(document.querySelectorAll('button'));
          return allButtons.find(btn => {
            const text = btn.textContent?.trim() || '';
            return text === 'Start' || text.includes('Start');
          });
        });
        
        if (startButtonElement) {
          await startButtonElement.asElement()?.click();
          console.log('✅ Puppeteer click executed!');
        }
      } catch (err) {
        console.log('⚠️ Puppeteer click failed:', err.message);
      }
      
      if (!startButtonClicked) {
        throw new Error('Could not find or click Start button');
      }
      
      console.log('✅ Start button clicked!');
      await new Promise(resolve => setTimeout(resolve, 2000));
      
    } else {
      console.log('📊 Detected Sparx Maths/other - looking for homework dropdown...');
      
      // Step: Click "Choose a homework task" dropdown (SAME method as Google dropdown!)
    console.log('📋 Looking for "Choose a homework task" dropdown...');
    const dropdownFound = await productPage.evaluate(() => {
      console.log('=== HOMEWORK DROPDOWN SEARCH ===');
      
      // Find ALL elements that might be the dropdown
      const allElements = Array.from(document.querySelectorAll('*'));
      
      // Look for elements with "Choose a homework task" text
      const candidates = allElements.filter(el => {
        const text = el.textContent?.trim() || '';
        return text.includes('Choose a homework task');
      });
      
      console.log(`Found ${candidates.length} elements with dropdown text`);
      
      candidates.forEach((el, i) => {
        const text = el.textContent?.trim();
        console.log(`  [${i}] "${text.substring(0, 50)}" - tag: ${el.tagName}, clickable: ${!!el.onclick}`);
      });
      
      // Find the SHORTEST one (the actual button, not a parent container)
      const dropdown = candidates.sort((a, b) => {
        const aText = a.textContent?.trim().length || 9999;
        const bText = b.textContent?.trim().length || 9999;
        return aText - bText;
      })[0];
      
      if (dropdown) {
        const text = dropdown.textContent?.trim();
        console.log(`✅ Selected shortest match: "${text}"`);
        console.log(`   Tag: ${dropdown.tagName}, ID: ${dropdown.id}, Class: ${dropdown.className}`);
        
        // Scroll into view
        dropdown.scrollIntoView({ behavior: 'smooth', block: 'center' });
        console.log('📜 Scrolled into view');
        
        // Try multiple click methods (SAME as Google dropdown)
        console.log('🖱️ Attempting click method 1: element.click()');
        dropdown.click();
        
        console.log('🖱️ Attempting click method 2: dispatchEvent');
        dropdown.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        
        console.log('🖱️ Attempting click method 3: mousedown + mouseup');
        dropdown.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
        dropdown.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
        
        console.log('✅ Tried all click methods!');
        return true;
      }
      
      console.log('❌ Dropdown not found');
      return false;
    });
    
    // Also try Puppeteer's native click as backup (SAME as Google dropdown)
    console.log('🖱️ Also trying Puppeteer native click...');
    try {
      const dropdownElement = await productPage.evaluateHandle(() => {
        const allElements = Array.from(document.querySelectorAll('*'));
        const candidates = allElements.filter(el => {
          const text = el.textContent?.trim() || '';
          return text.includes('Choose a homework task');
        });
        return candidates.sort((a, b) => {
          const aText = a.textContent?.trim().length || 9999;
          const bText = b.textContent?.trim().length || 9999;
          return aText - bText;
        })[0];
      });
      
      if (dropdownElement) {
        await dropdownElement.asElement()?.click();
        console.log('✅ Puppeteer click executed!');
      }
    } catch (err) {
      console.log('⚠️ Puppeteer click failed:', err.message);
    }
    
    if (!dropdownFound) {
      console.log('❌ Could not find homework dropdown!');
      console.log('🔍 Debugging: Looking for all text on page...');
      
      // Debug: show what text exists
      await productPage.evaluate(() => {
        const allText = Array.from(document.querySelectorAll('*'))
          .map(el => el.textContent?.trim() || '')
          .filter(text => text.length > 0 && text.length < 100);
        
        const uniqueText = [...new Set(allText)];
        console.log('Page text found:', uniqueText.slice(0, 20));
      });
      
      throw new Error('Could not find "Choose a homework task" dropdown');
    }
    
    console.log('✅ Clicked homework dropdown!');
    
    // Wait LONGER for dropdown options to fully appear
    console.log('⏳ Waiting for homework list to appear...');
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Step: Select the TOP homework (most recent) - SAME aggressive clicking method!
    console.log('📝 Selecting TOP homework (most recent)...');
    const homeworkSelected = await productPage.evaluate(() => {
      console.log('=== HOMEWORK SELECTION ===');
      
      // Find all homework options - they contain "Homework due"
      const allElements = Array.from(document.querySelectorAll('*'));
      const homeworkOptions = allElements.filter(el => {
        const text = el.textContent?.trim() || '';
        return text.startsWith('Homework due') && text.includes('%');
      });
      
      console.log(`Found ${homeworkOptions.length} homework options`);
      
      homeworkOptions.forEach((opt, i) => {
        const text = opt.textContent?.trim();
        console.log(`  [${i}] "${text}" - tag: ${opt.tagName}`);
      });
      
      if (homeworkOptions.length > 0) {
        // Sort by text length to find the ACTUAL clickable element (shortest = most specific)
        const sortedHomework = homeworkOptions.sort((a, b) => {
          const aText = a.textContent?.trim().length || 9999;
          const bText = b.textContent?.trim().length || 9999;
          return aText - bText;
        });
        
        // The shortest one should be the actual clickable homework item
        const topHomework = sortedHomework[0];
        const homeworkText = topHomework.textContent?.trim();
        
        console.log(`✅ Selecting TOP homework (shortest element): ${homeworkText}`);
        console.log(`   Tag: ${topHomework.tagName}, ID: ${topHomework.id}, Class: ${topHomework.className}`);
        
        // Scroll into view
        topHomework.scrollIntoView({ behavior: 'smooth', block: 'center' });
        console.log('📜 Scrolled into view');
        
        // Try MULTIPLE click methods (SAME as Google!)
        console.log('🖱️ Attempting click method 1: element.click()');
        topHomework.click();
        
        console.log('🖱️ Attempting click method 2: dispatchEvent');
        topHomework.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        
        console.log('🖱️ Attempting click method 3: mousedown + mouseup');
        topHomework.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
        topHomework.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
        
        console.log('✅ Tried all click methods!');
        
        return { success: true, homework: homeworkText };
      }
      
      console.log('❌ No homework options found');
      return { success: false, homework: 'Unknown' };
    });
    
    // Also try Puppeteer's native click as backup
    console.log('🖱️ Also trying Puppeteer native click on homework...');
    try {
      const homeworkElement = await productPage.evaluateHandle(() => {
        const allElements = Array.from(document.querySelectorAll('*'));
        const homeworkOptions = allElements.filter(el => {
          const text = el.textContent?.trim() || '';
          return text.startsWith('Homework due') && text.includes('%');
        });
        
        // Sort to get the shortest (most specific clickable element)
        const sortedHomework = homeworkOptions.sort((a, b) => {
          const aText = a.textContent?.trim().length || 9999;
          const bText = b.textContent?.trim().length || 9999;
          return aText - bText;
        });
        
        return sortedHomework[0]; // Shortest = most specific
      });
      
      if (homeworkElement) {
        await homeworkElement.asElement()?.click();
        console.log('✅ Puppeteer click executed on homework!');
      }
    } catch (err) {
      console.log('⚠️ Puppeteer click failed:', err.message);
    }
    
    // Wait a bit longer for the click to register
    await new Promise(resolve => setTimeout(resolve, 1000));
    
      if (!homeworkSelected.success) {
        throw new Error('Could not find or select homework options');
      }
      
      console.log(`✅ Selected homework: ${homeworkSelected.homework}`);
    }
    
    console.log('⏳ Waiting for queue processing...');
    
    // Wait for initial processing
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Navigate to Discord DM to watch for confirmation
    console.log('🔄 Navigating to Discord DM to watch for confirmation...');
    const dmUrl = 'https://discord.com/channels/@me/1461137151008706685';
    
    try {
      await productPage.goto(dmUrl, { waitUntil: 'networkidle2', timeout: 30000 });
      console.log('✅ Navigated to Discord DM');
    } catch (err) {
      console.log('⚠️ Navigation to DM failed:', err.message);
      console.log('⚠️ Continuing anyway - homework may still process');
    }
    
    // Wait and check for confirmation message
    let productType = 'Sparx Maths';
    if (productName.toLowerCase().includes('reader')) {
      productType = 'Sparx Reader';
    } else if (productName.toLowerCase().includes('seneca')) {
      productType = 'Seneca';
    } else if (productName.toLowerCase().includes('educate')) {
      productType = 'Educate';
    }
    
    console.log(`👀 Watching for "${productType}" confirmation message...`);
    console.log('⏳ This can take a few minutes depending on queue...');
    
    let messageFound = false;
    let checkAttempts = 0;
    const maxWaitAttempts = 60; // 60 attempts x 5 seconds = 5 minutes max wait
    
    while (!messageFound && checkAttempts < maxWaitAttempts) {
      checkAttempts++;
      
      await new Promise(resolve => setTimeout(resolve, 5000)); // Check every 5 seconds
      
      // Check for the message
      messageFound = await productPage.evaluate((productName) => {
        const allText = Array.from(document.querySelectorAll('*'))
          .map(el => el.textContent?.trim() || '');
        
        // Look for product-specific confirmation
        const hasConfirmation = allText.some(text => {
          if (productName.toLowerCase().includes('reader')) {
            return text.includes('Sparx Reader') || 
                   text.includes('reading') ||
                   text.includes('Reading');
          } else if (productName.toLowerCase().includes('seneca')) {
            return text.includes('Seneca') ||
                   text.includes('homework') ||
                   text.includes('completed');
          } else if (productName.toLowerCase().includes('educate')) {
            return text.includes('Educate') ||
                   text.includes('starting') ||
                   text.includes('Starting');
          } else {
            return text.includes('Sparx Maths Autocompleter') ||
                   text.includes('starting') ||
                   text.includes('Starting');
          }
        });
        
        if (hasConfirmation) {
          console.log('✅ Confirmation message found!');
          return true;
        }
        
        return false;
      }, productName);
      
      if (messageFound) {
        console.log(`✅ Homework started! (confirmed after ${checkAttempts * 5} seconds)`);
        break;
      }
      
      if (checkAttempts % 6 === 0) { // Every 30 seconds
        console.log(`⏳ Still waiting for confirmation... (${checkAttempts * 5}s elapsed)`);
      }
    }
    
    if (!messageFound) {
      console.log('⚠️ Timeout waiting for Discord confirmation');
      console.log('⚠️ Homework may still be processing - check Discord manually');
    }
    
    // Increment counter
    dailySubmissions++;
    
    console.log('');
    console.log('═══════════════════════════════════════════════════════');
    console.log('✅ HOMEWORK SUBMISSION SUCCESSFUL!');
    console.log('═══════════════════════════════════════════════════════');
    console.log('');
    console.log(`📊 Product: ${productName}`);
    console.log(`👤 Customer: ${username}`);
    console.log(`📈 Daily usage: ${dailySubmissions}/${CONFIG.maxDailySlots}`);
    console.log('');
    console.log('💡 Watch Discord for progress messages!');
    console.log('   - SparxNow will message you in your Discord DM');
    console.log('   - Progress updates will appear');
    console.log('   - Can take 5-10 minutes to complete');
    console.log('');
    console.log('═══════════════════════════════════════════════════════');
    console.log('');
    
    return {
      success: true,
      remainingSlots: CONFIG.maxDailySlots - dailySubmissions,
      usedSlots: dailySubmissions,
      maxSlots: CONFIG.maxDailySlots
    };
    
  } catch (error) {
    console.error('❌ Error submitting job:', error.message);
    
    // Don't count this as a used slot since it failed
    if (dailySubmissions > 0) {
      dailySubmissions--;
    }
    
    return {
      success: false,
      error: error.message,
      remainingSlots: CONFIG.maxDailySlots - dailySubmissions,
      usedSlots: dailySubmissions,
      maxSlots: CONFIG.maxDailySlots
    };
  }
}

// Cleanup on exit
process.on('SIGINT', async () => {
  console.log('\n\n🛑 Shutting down browser...');
  if (browser) {
    await browser.close();
  }
  process.exit(0);
});

// Export functions
module.exports = {
  initBrowser,
  submitToSparxNow,
  getStatus,
  canSubmitJob,
  resetDailyCounter,
  getTabsStatus,
  isTabBusy
};
