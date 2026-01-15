# Stripe Success Page URL Setup Guide

## Step 1: Find Your Website URL

### If using GitHub Pages:
1. Go to your GitHub repository
2. Click **Settings** → **Pages** (in the left sidebar)
3. You'll see your GitHub Pages URL, like:
   - `https://yourusername.github.io/repository-name`
   - OR if you have a custom domain, use that domain

### Examples:
- If your repo is `https://github.com/johnsmith/hwplug`, your URL is: `https://johnsmith.github.io/hwplug`
- If you have a custom domain like `hwplug.com`, use: `https://hwplug.com`

---

## Step 2: Edit Your Stripe Payment Links

1. **Log in to Stripe Dashboard**: https://dashboard.stripe.com
2. Go to **Products** → **Payment Links** (or search "Payment Links" in the top search bar)
3. **Find each payment link** you want to update:
   - Sparx Reader
   - Sparx Maths
   - Seneca
   - Educate
4. **Click on each payment link** to edit it
5. Scroll down to find **"Success page"** or **"After payment"** section
6. Look for **"Success page URL"** field

---

## Step 3: Enter the Success URL

### In the "Success page URL" field, enter:

**If using GitHub Pages:**
```
https://YOUR-USERNAME.github.io/YOUR-REPO-NAME/success.html?session_id={CHECKOUT_SESSION_ID}
```

**If using a custom domain:**
```
https://yourdomain.com/success.html?session_id={CHECKOUT_SESSION_ID}
```

### ⚠️ IMPORTANT:
- Replace `YOUR-USERNAME` with your GitHub username
- Replace `YOUR-REPO-NAME` with your repository name
- **KEEP** `{CHECKOUT_SESSION_ID}` exactly as shown (Stripe will replace this automatically)
- Make sure to include `?session_id={CHECKOUT_SESSION_ID}` at the end

### ✅ YOUR EXACT URL TO USE:
Since your website is at `https://mowasi98.github.io/officialhwplug/`, enter this EXACT URL in Stripe:

```
https://mowasi98.github.io/officialhwplug/success.html?session_id={CHECKOUT_SESSION_ID}
```

**Copy and paste this URL exactly as shown above!**

---

## Step 4: Save Changes

1. Click **"Save"** or **"Update"** button
2. **Repeat for all 4 payment links** (Sparx Reader, Sparx Maths, Seneca, Educate)

---

## Step 5: Test It

1. Use Stripe's **Test Mode** to make a test payment
2. After completing the payment, you should be redirected to your `success.html` page
3. You should receive an email with all the customer details

---

## Troubleshooting

**If the redirect doesn't work:**
- Make sure your `success.html` file is uploaded to GitHub
- Check that GitHub Pages is enabled and your site is live
- Verify the URL is correct (no typos, correct username/repo name)
- Make sure `{CHECKOUT_SESSION_ID}` is included at the end

**Need help finding your GitHub Pages URL?**
- Check: `https://github.com/YOUR-USERNAME/YOUR-REPO/settings/pages`
- Or look at your repository's **About** section - it may show the website link
