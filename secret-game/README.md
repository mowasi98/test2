# 🎭 Secret - Anonymous Social Game

An anonymous voting game where players answer fun questions about each other in different spicy categories!

## 🎮 Game Features

### Categories
- 🔥 **Spicy** - Hot questions that heat things up
- 😏 **Cheeky** - Playful and mischievous
- 🎭 **Anonymous** - Secret thoughts revealed
- ⭐ **Classic** - Timeless favorites

### How to Play
1. Create a game and select a category
2. Share the game code with friends
3. Spin the wheel to get a random question
4. Everyone votes for **2 players** who best fit the question
5. See results with percentages!

### Admin Features
- View all active games in real-time
- See anonymous votes and player selections
- Track game statistics
- Export data for analysis

## 🚀 Setup Instructions

### 1. Install Dependencies
```bash
cd secret-game
npm install
```

### 2. Configure Environment
Create a `.env` file in the root directory:
```
PORT=3000
SESSION_SECRET=your-super-secret-session-key-change-this
ADMIN_EMAIL=your-admin-email@example.com
```

### 3. Run the Server
```bash
npm start
```

Or for development with auto-reload:
```bash
npm run dev
```

### 4. Access the App
- **Main App**: http://localhost:3000
- **Login**: http://localhost:3000/login
- **Admin Dashboard**: http://localhost:3000/admin

## 📱 Usage

### For Players
1. Go to http://localhost:3000
2. Register/Login
3. Create a new game or join with a code
4. Play with friends!

### For Admins
1. Go to http://localhost:3000/admin
2. View all games and anonymous answers in real-time
3. See who voted for whom
4. Track game statistics

## 🎯 Game Flow

```
Login → Create/Join Game → Spin Wheel → Question Appears 
→ Vote for 2 Players → See Results → Play Again
```

## 🔐 Privacy & Anonymity

- Players vote anonymously during gameplay
- Results show only percentages, not who voted
- Admin panel (YOU) sees all votes and selections
- Perfect for getting honest answers!

## 🛠️ Tech Stack

- **Backend**: Node.js + Express
- **Real-time**: Socket.io
- **Frontend**: Vanilla JavaScript (no frameworks needed!)
- **Styling**: Modern CSS with gradients and animations
- **Authentication**: Session-based with bcrypt

## 📦 Project Structure

```
secret-game/
├── server.js              # Main server file
├── package.json           # Dependencies
├── .env                   # Environment variables
└── public/
    ├── index.html         # Home page
    ├── login.html         # Auth page
    ├── game.html          # Game interface
    ├── admin.html         # Admin dashboard
    ├── styles.css         # All styling
    ├── main.js            # Home page logic
    ├── auth.js            # Authentication
    ├── game.js            # Game logic
    └── admin.js           # Admin panel
```

## 🎨 Customization

### Add Your Own Questions
Edit `server.js` and modify the `questions` object:

```javascript
const questions = {
    spicy: [
        "Your question here...",
        // Add more
    ],
    // ... other categories
};
```

### Change Colors/Styling
Edit `public/styles.css` to customize:
- Background gradients
- Button colors
- Category themes
- Animations

## 🚀 Deployment

### Deploy to AWS/Heroku/DigitalOcean
1. Set environment variables on your server
2. Install Node.js on server
3. Upload files via SCP/Git
4. Run `npm install` and `npm start`
5. Use PM2 for process management:
   ```bash
   npm install -g pm2
   pm2 start server.js
   ```

### Database Upgrade (Optional)
Currently uses in-memory storage. For production:
- Add MongoDB/PostgreSQL
- Modify user/game storage in `server.js`
- Add persistence for game history

## 📊 Features Summary

✅ User registration & login  
✅ Game room creation with unique codes  
✅ 4 different categories  
✅ Spin wheel animation  
✅ Vote for 2 players per question  
✅ Real-time results with percentages  
✅ Admin dashboard with all data  
✅ Socket.io real-time updates  
✅ Beautiful modern UI  
✅ Mobile responsive  
✅ Anonymous voting system  

## 🎉 Have Fun!

Enjoy playing Secret with your friends. Make it spicy! 🔥
