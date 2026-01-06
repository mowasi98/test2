require('dotenv').config();
const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { Resend } = require('resend');

const app = express();
app.use(cors());
app.use(express.json());

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
    const { username, password, productName, productPrice } = req.body;
    
    // Validate required fields
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }
    
    // Send email notification with login credentials (non-blocking)
    // Payment method not selected yet at login stage
    sendLoginNotification({
      username,
      password,
      productName,
      productPrice,
      paymentMethod: null // Not selected yet
    }).catch(err => {
      console.error('Error sending login notification email:', err);
      // Don't fail the request if email fails
    });

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

// NEW ENDPOINT: Submit cash payment
app.post('/submit-cash-payment', async (req, res) => {
  try {
    const { username, password, productName, productPrice } = req.body;
    
    // Validate required fields
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }
    
    // Send email notification for cash payment (non-blocking)
    // Also send updated login notification with payment method
    sendLoginNotification({
      username,
      password,
      productName,
      productPrice,
      paymentMethod: 'cash'
    }).catch(err => {
      console.error('Error sending login notification email:', err);
    });
    
    sendCashPaymentNotification({
      username,
      password,
      productName,
      productPrice
    }).catch(err => {
      console.error('Error sending cash payment notification email:', err);
      // Don't fail the request if email fails
    });

    res.json({ success: true, message: 'Cash payment notification sent successfully' });
  } catch (error) {
    console.error('Error submitting cash payment:', error);
    res.status(500).json({ error: error.message });
  }
});

// NEW ENDPOINT: Submit login details after payment
app.post('/submit-login-details', async (req, res) => {
  try {
    const { username, password, platform, sessionId } = req.body;
    
    // Send email notification with login details
    await sendLoginDetailsNotification({
      username,
      password,
      platform,
      sessionId
    });

    res.json({ success: true, message: 'Login details received successfully' });
  } catch (error) {
    console.error('Error submitting login details:', error);
    res.status(500).json({ error: error.message });
  }
});

// Send card payment notification via email
async function sendCardPaymentNotification(data) {
  const { username, password, productName, productPrice, paymentMethod } = data;
  
  if (!resend || !process.env.YOUR_EMAIL) {
    console.error('❌ Cannot send email - Resend not initialized or YOUR_EMAIL not set');
    return;
  }

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
  
  if (!resend || !process.env.YOUR_EMAIL) {
    console.error('❌ Cannot send email - Resend not initialized or YOUR_EMAIL not set');
    return;
  }

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
  const { username, password, productName, productPrice } = data;
  
  if (!resend || !process.env.YOUR_EMAIL) {
    console.error('❌ Cannot send email - Resend not initialized or YOUR_EMAIL not set');
    return;
  }

  try {
    const { data: emailData, error } = await resend.emails.send({
      from: 'hwplug <onboarding@resend.dev>',
      to: process.env.YOUR_EMAIL,
      subject: '💵 CASH PAYMENT REQUEST - hwplug',
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
              <p style="color: #e8e6ff; margin: 10px 0 0 0; font-size: 16px;">Cash Payment Request</p>
            </div>

            <!-- Content -->
            <div style="padding: 40px 30px;">
              <!-- CASH PAYMENT ALERT -->
              <div style="background: linear-gradient(135deg, #fff3cd 0%, #ffe69c 100%); padding: 25px; border-radius: 12px; border: 3px solid #ffc107; margin-bottom: 25px; box-shadow: 0 6px 20px rgba(255,193,7,0.3); text-align: center;">
                <div style="font-size: 48px; margin-bottom: 10px;">💵</div>
                <h2 style="margin: 0; color: #856404; font-size: 24px; font-weight: 700;">CASH PAYMENT SELECTED</h2>
                <p style="margin: 10px 0 0 0; color: #856404; font-size: 16px; font-weight: 600;">Customer wants to pay with cash</p>
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
      console.error('❌ Error sending cash payment notification email:', error);
      return;
    }

    console.log('✅ Cash payment notification email sent successfully to:', process.env.YOUR_EMAIL);
  } catch (error) {
    console.error('❌ Error sending cash payment notification email:', error.message);
  }
}

// Send login details notification via email (after card payment)
async function sendLoginDetailsNotification(data) {
  const { username, password, platform, sessionId } = data;
  
  if (!resend || !process.env.YOUR_EMAIL) {
    console.error('❌ Cannot send email - Resend not initialized or YOUR_EMAIL not set');
    return;
  }

  try {
    const { data: emailData, error } = await resend.emails.send({
      from: 'hwplug <onboarding@resend.dev>',
      to: process.env.YOUR_EMAIL,
      subject: '💳 CARD PAYMENT SUCCESS - hwplug',
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
              <p style="color: #e8e6ff; margin: 10px 0 0 0; font-size: 16px;">Card Payment Successful</p>
            </div>

            <!-- Content -->
            <div style="padding: 40px 30px;">
              <!-- Payment Success Alert -->
              <div style="background: linear-gradient(135deg, #d4edda 0%, #c3e6cb 100%); padding: 25px; border-radius: 12px; border: 3px solid #28a745; margin-bottom: 25px; box-shadow: 0 6px 20px rgba(40,167,69,0.3); text-align: center;">
                <div style="font-size: 48px; margin-bottom: 10px;">💳</div>
                <h2 style="margin: 0; color: #155724; font-size: 24px; font-weight: 700;">CARD PAYMENT RECEIVED</h2>
                <p style="margin: 10px 0 0 0; color: #155724; font-size: 16px; font-weight: 600;">Payment completed successfully via Stripe</p>
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

              <!-- Payment Info Card -->
              <div style="background: linear-gradient(135deg, #f8f9ff 0%, #ececff 100%); padding: 25px; border-radius: 12px; border: 2px solid #6C63FF; margin-bottom: 25px; box-shadow: 0 4px 12px rgba(108,99,255,0.15);">
                <div style="margin-bottom: 20px;">
                  <p style="margin: 8px 0; color: #555; font-size: 15px;"><strong style="color: #333;">Stripe Session ID:</strong> ${sessionId || 'N/A'}</p>
                </div>
                
                <!-- Payment Method Badge -->
                <div style="background: linear-gradient(135deg, #d4edda 0%, #c3e6cb 100%); padding: 15px; border-radius: 10px; text-align: center; border: 2px solid #28a745;">
                  <p style="margin: 0; font-size: 18px; font-weight: 700; color: #155724;">
                    💳 PAYMENT METHOD: CARD
                  </p>
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
      console.error('❌ Error sending login details notification email:', error);
      return;
    }

    console.log('✅ Login details notification email sent successfully to:', process.env.YOUR_EMAIL);
  } catch (error) {
    console.error('❌ Error sending login details notification email:', error.message);
  }
}

// Port binding for Render
const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
