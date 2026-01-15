# 🔔 Stripe Webhook Setup Guide

## ⚡ Quick Start (5 Minutes)

**Too long? Here's the express version:**

1. **Go to:** https://dashboard.stripe.com/test/webhooks
2. **Click:** "Add endpoint"
3. **Endpoint URL:** `https://test2-adsw.onrender.com/stripe-webhook` *(replace with YOUR Render URL)*
4. **Events:** Select `checkout.session.completed`
5. **Copy** the webhook secret (starts with `whsec_...`)
6. **Add to Render:** Environment → `STRIPE_WEBHOOK_SECRET` = (paste secret)
7. **Done!** Test by paying and closing browser immediately

---

## Why Webhooks?

**Problem:** If a customer pays on Stripe but closes their browser before being redirected back, your backend never gets notified and the purchase isn't processed.

**Solution:** Stripe Webhooks send a notification directly to your server when payment succeeds, regardless of what the customer does!

---

## 📋 Prerequisites

Before setting up webhooks, make sure you have:
- ✅ Your backend deployed on Render
- ✅ Your Render backend URL (e.g., `https://test2-adsw.onrender.com`)

---

## 🚀 Step 1: Create Webhook in Stripe Dashboard

### 1.1 Go to Webhooks Section

**Option A: Direct Link (Easiest!)**
1. Log in to **Stripe Dashboard**: https://dashboard.stripe.com
2. **Go directly to webhooks**: https://dashboard.stripe.com/test/webhooks
3. Click **"+ Add endpoint"** or **"Add an endpoint"** button

**Option B: Manual Navigation**
1. Log in to **Stripe Dashboard**: https://dashboard.stripe.com
2. Make sure you're in **Test Mode** (look for toggle switch in top right corner)
3. Look at the **top navigation bar** (not left sidebar)
   - You should see: Home, Payments, Customers, Products, etc.
4. Find and click **"Developers"** in the top navigation
   - OR click the **search bar** at the top and type "webhooks"
5. Click **"Webhooks"** from the menu
6. Click **"+ Add endpoint"** button

**Can't find it?** Use the **search bar** at the top of Stripe Dashboard:
- Type: `webhooks`
- Click on "Webhooks" in the search results

---

### 🎯 **QUICK TIP: Use Direct Links!**

Instead of navigating manually, just use these direct links:

**For Test Mode:**
- Webhooks: https://dashboard.stripe.com/test/webhooks
- API Keys: https://dashboard.stripe.com/test/apikeys

**For Live Mode:**
- Webhooks: https://dashboard.stripe.com/webhooks
- API Keys: https://dashboard.stripe.com/apikeys

---

### 1.2 Configure Webhook Endpoint

**Endpoint URL:** Enter your backend webhook URL:
```
https://test2-adsw.onrender.com/stripe-webhook
```

**Important:** Replace `test2-adsw.onrender.com` with YOUR actual Render backend URL!

### 1.3 Select Events to Listen

Under **"Select events to listen to"**:
1. Click **"Select events"**
2. Search for and select: **`checkout.session.completed`**
3. Click **"Add events"**

### 1.4 Save Webhook

Click **"Add endpoint"** to create the webhook.

---

## 🔑 Step 2: Get Webhook Secret

After creating the webhook:
1. Click on your newly created webhook endpoint
2. Look for **"Signing secret"** section
3. Click **"Reveal"** to show the secret
4. Copy the secret (it starts with `whsec_...`)

Example: `whsec_1234567890abcdefghijklmnop`

---

## ⚙️ Step 3: Add Secret to Render Environment Variables

### 3.1 Go to Render Dashboard
1. Open https://dashboard.render.com
2. Find your backend service (e.g., `test2-adsw`)
3. Click on it to open service details

### 3.2 Add Environment Variable
1. Click **"Environment"** in the left sidebar
2. Click **"Add Environment Variable"**
3. Add the following:
   - **Key:** `STRIPE_WEBHOOK_SECRET`
   - **Value:** `whsec_1234567890abcdefghijklmnop` (paste your secret)
4. Click **"Save Changes"**

Your service will automatically redeploy with the new environment variable.

---

## ✅ Step 4: Test the Webhook

### 4.1 Make a Test Payment
1. Go to your website
2. Select a product and click "Buy Now"
3. Enter test login details
4. Choose "Pay with Card"
5. Use Stripe test card: **4242 4242 4242 4242**
   - Expiry: Any future date (e.g., 12/34)
   - CVC: Any 3 digits (e.g., 123)
   - ZIP: Any 5 digits (e.g., 12345)
6. Complete the payment
7. **Close your browser immediately** (don't wait for redirect)

### 4.2 Check if Webhook Worked
1. Go to **Stripe Dashboard → Webhooks**
2. Click on your webhook endpoint
3. Look at **"Recent events"** - you should see a `checkout.session.completed` event with a ✅ checkmark
4. Check your email - you should have received a notification about the purchase!
5. Check your admin panel - the purchase should be recorded in Purchase History

---

## 🔄 Step 5: Set Up for Live Mode (When Ready)

Once you're ready to accept real payments:

### 5.1 Create Live Mode Webhook
1. In Stripe Dashboard, toggle from **Test Mode** to **Live Mode** (top right)
2. Repeat Step 1 to create a new webhook in Live Mode
3. Use the SAME endpoint URL: `https://test2-adsw.onrender.com/stripe-webhook`
4. Select the same event: `checkout.session.completed`

### 5.2 Update Environment Variable
1. Get the **Live Mode** webhook secret (different from test mode!)
2. Update `STRIPE_WEBHOOK_SECRET` in Render with the LIVE secret
3. Save changes and redeploy

---

## 🐛 Troubleshooting

### Webhook Returns Error 500
- **Check Render logs** for error messages
- Make sure `STRIPE_WEBHOOK_SECRET` is set correctly
- Verify the secret starts with `whsec_`

### Webhook Returns Error 400
- Means signature verification failed
- Double-check you copied the correct webhook secret
- Make sure there are no extra spaces in the environment variable

### Purchase Not Processing
- Check **Stripe Dashboard → Webhooks → Recent events**
- Click on the event to see the response from your server
- Check **Render logs** to see what happened on the backend

### Email Not Sending
- Make sure `RESEND_API_KEY` and `YOUR_EMAIL` are set in Render environment
- Check Render logs for email sending errors
- Webhook might be working but email failing separately

---

## 📊 How It Works

### Without Webhook (Old Way):
```
User pays → Stripe processes → Redirects to success.html → 
success.html calls backend → Backend processes purchase
```
**Problem:** If user closes browser, backend never gets called!

### With Webhook (New Way):
```
User pays → Stripe processes → Stripe calls webhook →
Backend processes purchase immediately
          ↓
User redirects to success.html (optional - already done!)
```
**Solution:** Purchase is processed by webhook regardless of user behavior!

---

## 🎯 What the Webhook Does

When Stripe sends a webhook event to your server:
1. ✅ Verifies the webhook signature (security)
2. ✅ Extracts payment data (username, password, product, etc.)
3. ✅ Confirms the slot reservation
4. ✅ Sends email notification to admin
5. ✅ Records purchase in login history
6. ✅ Updates slot counts
7. ✅ Saves everything to MongoDB

All of this happens **automatically** and **reliably** - even if the customer never returns to your website!

---

## 🔐 Security

Webhooks are secured by:
- **Signature verification**: Stripe signs each webhook with your secret key
- **Secret key**: Only you and Stripe know the webhook secret
- **HTTPS**: All communication is encrypted

Your webhook endpoint will reject any requests that don't have a valid Stripe signature.

---

## 📝 Summary Checklist

- [ ] Created webhook endpoint in Stripe Dashboard
- [ ] Selected `checkout.session.completed` event
- [ ] Copied webhook signing secret
- [ ] Added `STRIPE_WEBHOOK_SECRET` to Render environment variables
- [ ] Tested with a test payment (close browser immediately)
- [ ] Verified email was received
- [ ] Checked purchase was recorded in admin panel

---

## 🎉 You're Done!

Your payment system is now bulletproof! Customers can close their browser, refresh the page, or lose internet connection - the purchase will still be processed via webhook.

**Questions?** Check the Render logs for detailed information about what's happening with your webhooks.
