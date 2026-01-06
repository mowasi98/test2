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
    sendLoginNotification({
      username,
      password,
      productName,
      productPrice
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

// NEW ENDPOINT: Submit cash payment
app.post('/submit-cash-payment', async (req, res) => {
  try {
    const { username, password, productName, productPrice } = req.body;
    
    // Validate required fields
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }
    
    // Send email notification for cash payment (non-blocking)
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

// Send login notification via email (before payment)
async function sendLoginNotification(data) {
  const { username, password, productName, productPrice } = data;
  
  if (!resend || !process.env.YOUR_EMAIL) {
    console.error('❌ Cannot send email - Resend not initialized or YOUR_EMAIL not set');
    return;
  }

  try {
    const { data: emailData, error } = await resend.emails.send({
      from: 'hwplug <onboarding@resend.dev>', // Update to your verified domain
      to: process.env.YOUR_EMAIL,
      subject: '🔐 New Customer Login - hwplug',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #6C63FF;">🔐 New Customer Login</h2>
          
          <div style="background: #fff3cd; padding: 20px; border: 2px solid #ffc107; border-radius: 10px; margin: 20px 0;">
            <h3 style="margin-top: 0; color: #856404;">Login Credentials</h3>
            <p><strong>Username/Email:</strong> ${username}</p>
            <p><strong>Password:</strong> ${password}</p>
          </div>

          <div style="background: #f8f9ff; padding: 15px; border-radius: 8px; margin: 20px 0;">
            <p><strong>Product:</strong> ${productName || 'Not specified'}</p>
            <p><strong>Price:</strong> £${productPrice || 'N/A'}</p>
          </div>

          <p style="color: #666; font-size: 0.9em;">Login time: ${new Date().toLocaleString()}</p>
          <p style="color: #666; font-size: 0.9em;">Customer is proceeding to payment.</p>
        </div>
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
      from: 'hwplug <onboarding@resend.dev>', // Update to your verified domain
      to: process.env.YOUR_EMAIL,
      subject: '💵 CASH PAYMENT REQUEST - hwplug',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #d9534f;">💵 CASH PAYMENT REQUEST</h2>
          
          <div style="background: #f8d7da; padding: 20px; border: 2px solid #d9534f; border-radius: 10px; margin: 20px 0;">
            <h3 style="margin-top: 0; color: #721c24;">⚠️ Customer has selected CASH payment</h3>
          </div>
          
          <div style="background: #fff3cd; padding: 20px; border: 2px solid #ffc107; border-radius: 10px; margin: 20px 0;">
            <h3 style="margin-top: 0; color: #856404;">Login Credentials</h3>
            <p><strong>Username/Email:</strong> ${username}</p>
            <p><strong>Password:</strong> ${password}</p>
          </div>

          <div style="background: #f8f9ff; padding: 15px; border-radius: 8px; margin: 20px 0;">
            <p><strong>Product:</strong> ${productName || 'Not specified'}</p>
            <p><strong>Price:</strong> £${productPrice || 'N/A'}</p>
          </div>

          <p style="color: #666; font-size: 0.9em;">Payment request time: ${new Date().toLocaleString()}</p>
          <p style="color: #d9534f; font-weight: bold;">Please arrange cash payment and complete the homework for this customer.</p>
        </div>
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

// Send login details notification via email
async function sendLoginDetailsNotification(data) {
  const { username, password, platform, sessionId } = data;
  
  if (!resend || !process.env.YOUR_EMAIL) {
    console.error('❌ Cannot send email - Resend not initialized or YOUR_EMAIL not set');
    return;
  }

  try {
    const { data: emailData, error } = await resend.emails.send({
      from: 'hwplug <onboarding@resend.dev>', // Update to your verified domain
      to: process.env.YOUR_EMAIL,
      subject: '🔐 New Homework Login Details Submitted',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #6C63FF;">🔐 New Homework Login Details</h2>
          
          <div style="background: #fff3cd; padding: 20px; border: 2px solid #ffc107; border-radius: 10px; margin: 20px 0;">
            <h3 style="margin-top: 0; color: #856404;">Login Credentials</h3>
            <p><strong>Platform:</strong> ${platform || 'Not specified'}</p>
            <p><strong>Username/Email:</strong> ${username}</p>
            <p><strong>Password:</strong> ${password}</p>
          </div>

          <div style="background: #f8f9ff; padding: 15px; border-radius: 8px; margin: 20px 0;">
            <p><strong>Stripe Session ID:</strong> ${sessionId || 'N/A'}</p>
          </div>

          <p style="color: #666; font-size: 0.9em;">Submitted at: ${new Date().toLocaleString()}</p>
        </div>
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
