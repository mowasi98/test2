require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const session = require('express-session');
const bodyParser = require('body-parser');
const bcrypt = require('bcryptjs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(session({
    secret: process.env.SESSION_SECRET || 'secret-game-default-session-key-change-in-production',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false } // Set to true if using HTTPS
}));

// In-memory storage (replace with database in production)
const users = new Map(); // userId -> {username, email, passwordHash}
const games = new Map(); // gameCode -> {id, players, category, currentQuestion, votes, createdAt, adminEmail}
const questions = {
    spicy: [
        "Who is most likely to hook up with someone at this party?",
        "Who would be the best kisser?",
        "Who is most likely to have a secret crush on someone here?",
        "Who would you want to be stuck on a desert island with?",
        "Who is most likely to send a risky text?",
        "Who has the best body?",
        "Who is most likely to make the first move?",
        "Who would you date if you were single?"
    ],
    cheeky: [
        "Who is most likely to get away with murder?",
        "Who would survive a zombie apocalypse the longest?",
        "Who is most likely to become famous?",
        "Who would win in a dance battle?",
        "Who has the best sense of humor?",
        "Who is most likely to embarrass themselves in public?",
        "Who would be the worst roommate?",
        "Who is most likely to go viral on TikTok?"
    ],
    anonymous: [
        "Who do you secretly admire the most?",
        "Who would you trust with your biggest secret?",
        "Who do you think likes you?",
        "Who do you find most attractive?",
        "Who would you want to know what they think about you?",
        "Who do you want to get closer to?",
        "Who do you think talks about you behind your back?",
        "Who do you wish you knew better?"
    ],
    classic: [
        "Who is most likely to become a millionaire?",
        "Who is the most talented person here?",
        "Who would make the best leader?",
        "Who is most likely to travel the world?",
        "Who has the best style?",
        "Who is most likely to help you in a crisis?",
        "Who would you want on your team?",
        "Who is most likely to achieve their dreams?"
    ]
};

// Helper function to generate random game code
function generateGameCode() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/game', (req, res) => {
    if (!req.session.userId) {
        return res.redirect('/login');
    }
    res.sendFile(path.join(__dirname, 'public', 'game.html'));
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Helper function to validate email
function isValidEmail(email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
        return false;
    }
    const parts = email.split('@');
    if (parts.length !== 2) {
        return false;
    }
    const domain = parts[1];
    if (!domain.includes('.') || domain.split('.').pop().length < 2) {
        return false;
    }
    return true;
}

// API: Register
app.post('/api/register', async (req, res) => {
    const { username, email, password } = req.body;
    
    if (!username || !email || !password) {
        return res.status(400).json({ error: 'All fields required' });
    }
    
    // Validate email format
    if (!isValidEmail(email)) {
        return res.status(400).json({ error: 'Invalid email format. Must include @ and domain (e.g., .com)' });
    }
    
    // Validate password length
    if (password.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }
    
    // Check if user exists
    for (let [id, user] of users) {
        if (user.email === email) {
            return res.status(400).json({ error: 'Email already registered' });
        }
    }
    
    const userId = Date.now().toString();
    const passwordHash = await bcrypt.hash(password, 10);
    
    users.set(userId, { username, email, passwordHash });
    req.session.userId = userId;
    
    res.json({ success: true, userId, username });
});

// API: Login
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    
    if (!email || !password) {
        return res.status(400).json({ error: 'All fields required' });
    }
    
    // Validate email format
    if (!isValidEmail(email)) {
        return res.status(400).json({ error: 'Invalid email format' });
    }
    
    let foundUser = null;
    let foundUserId = null;
    
    for (let [id, user] of users) {
        if (user.email === email) {
            foundUser = user;
            foundUserId = id;
            break;
        }
    }
    
    if (!foundUser) {
        return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const validPassword = await bcrypt.compare(password, foundUser.passwordHash);
    if (!validPassword) {
        return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    req.session.userId = foundUserId;
    res.json({ success: true, userId: foundUserId, username: foundUser.username });
});

// API: Create game
app.post('/api/game/create', (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: 'Not authenticated' });
    }
    
    const { category } = req.body;
    const gameCode = generateGameCode();
    const user = users.get(req.session.userId);
    
    games.set(gameCode, {
        id: gameCode,
        players: [{ id: req.session.userId, username: user.username }],
        category: category || 'classic',
        currentQuestion: null,
        votes: {},
        createdAt: new Date(),
        createdBy: user.username,
        createdByEmail: user.email,
        adminEmail: user.email,
        isActive: true,
        spinHistory: [],
        customQuestions: []
    });
    
    res.json({ success: true, gameCode });
});

// API: Join game
app.post('/api/game/join', (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: 'Not authenticated' });
    }
    
    const { gameCode } = req.body;
    const game = games.get(gameCode.toUpperCase());
    
    if (!game) {
        return res.status(404).json({ error: 'Game not found' });
    }
    
    const user = users.get(req.session.userId);
    const alreadyJoined = game.players.find(p => p.id === req.session.userId);
    
    if (!alreadyJoined) {
        game.players.push({ id: req.session.userId, username: user.username });
    }
    
    res.json({ success: true, game: { code: gameCode, category: game.category, players: game.players } });
});

// API: Add custom question to game
app.post('/api/game/add-question', (req, res) => {
    const { gameCode, type, question, username } = req.body;
    
    const game = games.get(gameCode.toUpperCase());
    
    if (!game) {
        return res.status(404).json({ error: 'Game not found' });
    }
    
    if (!game.customQuestions) game.customQuestions = [];
    
    game.customQuestions.push({
        type,
        question,
        username,
        addedAt: new Date()
    });
    
    res.json({ success: true });
});

// API: Get custom questions for a game
app.get('/api/game/questions', (req, res) => {
    const { gameCode } = req.query;
    
    const game = games.get(gameCode.toUpperCase());
    
    if (!game) {
        return res.status(404).json({ error: 'Game not found' });
    }
    
    res.json({ success: true, questions: game.customQuestions || [] });
});

// API: Get admin data
app.get('/api/admin/games', (req, res) => {
    const allGames = [];
    
    for (let [code, game] of games) {
        allGames.push({
            code,
            playerCount: game.players.length,
            category: game.category,
            createdAt: game.createdAt,
            createdBy: game.createdBy || (game.players[0] ? game.players[0].username : 'Unknown'),
            currentQuestion: game.currentQuestion,
            votes: game.votes,
            players: game.players,
            spinHistory: game.spinHistory || [],
            customQuestions: game.customQuestions || []
        });
    }
    
    res.json({ games: allGames });
});

// Socket.io real-time events
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);
    
    socket.on('joinGame', ({ gameCode, userId }) => {
        socket.join(gameCode);
        const game = games.get(gameCode);
        
        if (game) {
            io.to(gameCode).emit('playerJoined', { players: game.players });
        }
    });
    
    socket.on('startGame', ({ gameCode, category }) => {
        const game = games.get(gameCode);
        
        if (!game) return;
        
        let questionToSend = null;
        let questionType = null;
        
        if (category === 'anonymous') {
            // For anonymous, use custom questions
            if (game.customQuestions && game.customQuestions.length > 0) {
                const randomQ = game.customQuestions[Math.floor(Math.random() * game.customQuestions.length)];
                questionToSend = randomQ.question;
                questionType = randomQ.type;
            }
        } else {
            // For other categories, use pre-defined questions
            if (questions[game.category]) {
                const categoryQuestions = questions[game.category];
                questionToSend = categoryQuestions[Math.floor(Math.random() * categoryQuestions.length)];
                questionType = game.category;
            }
        }
        
        if (questionToSend) {
            game.currentQuestion = questionToSend;
            game.votes = {}; // Reset votes
            
            // Track question
            if (!game.spinHistory) game.spinHistory = [];
            game.spinHistory.push({
                username: 'System',
                userId: 'system',
                time: new Date(),
                question: questionToSend,
                type: questionType
            });
            
            io.to(gameCode).emit('gameStarted', {
                question: questionToSend,
                type: questionType,
                category: game.category
            });
        }
    });
    
    socket.on('questionAdded', ({ gameCode }) => {
        socket.to(gameCode).emit('questionAddedByOther');
    });
    
    socket.on('submitVote', ({ gameCode, userId, votes }) => {
        const game = games.get(gameCode);
        
        if (game) {
            game.votes[userId] = votes; // votes = [playerId1, playerId2]
            
            // Check if everyone voted
            const allVoted = game.players.length === Object.keys(game.votes).length;
            
            if (allVoted) {
                // Calculate results
                const voteCounts = {};
                game.players.forEach(p => voteCounts[p.id] = 0);
                
                Object.values(game.votes).forEach(playerVotes => {
                    playerVotes.forEach(votedId => {
                        voteCounts[votedId] = (voteCounts[votedId] || 0) + 1;
                    });
                });
                
                const totalVotes = Object.values(voteCounts).reduce((a, b) => a + b, 0);
                const results = game.players.map(p => ({
                    username: p.username,
                    votes: voteCounts[p.id],
                    percentage: totalVotes > 0 ? ((voteCounts[p.id] / totalVotes) * 100).toFixed(1) : 0
                })).sort((a, b) => b.votes - a.votes);
                
                io.to(gameCode).emit('resultsReady', { results });
            }
        }
    });
    
    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
    });
});

server.listen(PORT, () => {
    console.log(`🎮 Secret game running on http://localhost:${PORT}`);
});
