require('dotenv').config();
const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const nodemailer = require('nodemailer');

const app = express();
app.use(cors());
app.use(express.json());

// Health check endpoint
app.get('/', (req, res) => {
  res.send('hwplug Backend Running! 🚀');
});

// Email transporter setup
const transporter = nodemailer.createTransport({
  service: process.env.EMAIL_SERVICE,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD
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
  
  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: process.env.YOUR_EMAIL,
    subject: '🔐 New Customer Login - hwplug',
    text: `
New Customer Login
==================

Customer Login Credentials:
Username/Email: ${username}
Password: ${password}

Product: ${productName || 'Not specified'}
Price: £${productPrice || 'N/A'}

Login Time: ${new Date().toLocaleString()}

Customer is proceeding to payment.
    `,
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
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log('Login notification email sent successfully');
  } catch (error) {
    console.error('Error sending email:', error);
  }
}

// Send cash payment notification via email
async function sendCashPaymentNotification(data) {
  const { username, password, productName, productPrice } = data;
  
  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: process.env.YOUR_EMAIL,
    subject: '💵 CASH PAYMENT REQUEST - hwplug',
    text: `
CASH PAYMENT REQUEST
====================

⚠️ Customer has selected CASH payment method.

Customer Login Credentials:
Username/Email: ${username}
Password: ${password}

Product: ${productName || 'Not specified'}
Price: £${productPrice || 'N/A'}

Payment Time: ${new Date().toLocaleString()}

Please arrange cash payment and complete the homework for this customer.
    `,
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
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log('Cash payment notification email sent successfully');
  } catch (error) {
    console.error('Error sending email:', error);
  }
}

// Send login details notification via email
async function sendLoginDetailsNotification(data) {
  const { username, password, platform, sessionId } = data;
  
  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: process.env.YOUR_EMAIL,
    subject: '🔐 New Homework Login Details Submitted',
    text: `
New Homework Login Details
===========================

Platform: ${platform || 'Not specified'}
Username/Email: ${username}
Password: ${password}

Stripe Session ID: ${sessionId || 'N/A'}

Submission Time: ${new Date().toLocaleString()}

Please log in and complete the homework for this customer.
    `,
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
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log('Login details notification email sent successfully');
  } catch (error) {
    console.error('Error sending email:', error);
  }
}

// Port binding for Render
const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
