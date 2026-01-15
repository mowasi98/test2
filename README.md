# officialhwplug - Your Learning Marketplace

Educational service marketplace for homework help.

## Setup

### Backend (Node.js Server)
1. Install dependencies: `npm install`
2. Create a `.env` file with:
   ```
   YOUR_EMAIL=your-email@gmail.com
   EMAIL_SERVICE=gmail
   EMAIL_USER=your-email@gmail.com
   EMAIL_PASSWORD=your-app-password
   STRIPE_SECRET_KEY=your-stripe-secret-key
   PORT=10000
   ```
3. Start server: `npm start` or `node server.js`

### Frontend (GitHub Pages)
- Static HTML files served via GitHub Pages
- Make sure `index.html` is in the root directory

## Deployment

- **Frontend**: GitHub Pages (static HTML files)
- **Backend**: Render.com or similar (Node.js server)

## File Structure

```
/
├── index.html          # Main page
├── login.html          # Login page
├── payment.html        # Payment selection page
├── success.html        # Success page after payment
├── server.js           # Backend server (Node.js/Express)
├── package.json        # Node.js dependencies
└── .gitignore          # Git ignore file
```
