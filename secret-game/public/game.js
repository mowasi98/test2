// Game page JavaScript
const socket = io();
const gameCode = sessionStorage.getItem('gameCode');
const category = sessionStorage.getItem('category');
let selectedPlayers = [];
let selectedQuestionType = 'gossip';
let customQuestions = [];

if (!gameCode) {
    window.location.href = '/';
}

// Display game code
document.getElementById('displayGameCode').textContent = gameCode;
document.getElementById('displayGameCodeBig').textContent = gameCode;

const isAdmin = sessionStorage.getItem('isAdmin') === 'true';

// Show appropriate controls based on admin status and category
if (isAdmin) {
    document.getElementById('adminControls').style.display = 'block';
    if (category === 'anonymous') {
        document.getElementById('anonymousAdminControls').style.display = 'block';
    } else {
        document.getElementById('normalAdminControls').style.display = 'block';
    }
} else {
    document.getElementById('waitingMessage').style.display = 'block';
}

// Join the game room
socket.emit('joinGame', { gameCode, userId: Date.now().toString() });

// Listen for player updates
socket.on('playerJoined', (data) => {
    updatePlayersList(data.players);
});

function updatePlayersList(players) {
    const playersCircle = document.getElementById('playersCircle');
    playersCircle.innerHTML = '';
    
    players.forEach((player, index) => {
        const playerDiv = document.createElement('div');
        playerDiv.className = 'player-circle-item';
        playerDiv.style.setProperty('--player-index', index);
        playerDiv.style.setProperty('--total-players', players.length);
        
        // Profile picture
        const profilePic = localStorage.getItem('profilePicture_' + player.id);
        if (profilePic) {
            const img = document.createElement('img');
            img.src = profilePic;
            img.className = 'player-circle-pic';
            playerDiv.appendChild(img);
        } else {
            const placeholder = document.createElement('div');
            placeholder.className = 'player-circle-placeholder';
            placeholder.textContent = player.username.charAt(0).toUpperCase();
            playerDiv.appendChild(placeholder);
        }
        
        playersCircle.appendChild(playerDiv);
    });
    
    // Store players globally for voting
    window.gamePlayers = players;
}

function startGame() {
    const isAdmin = sessionStorage.getItem('isAdmin') === 'true';
    if (!isAdmin) {
        alert('Only the host can start the game!');
        return;
    }
    
    socket.emit('startGame', { gameCode, category });
}

// Listen for game start
socket.on('gameStarted', (data) => {
    document.getElementById('waitingRoom').style.display = 'none';
    document.getElementById('questionPhase').style.display = 'block';
    
    document.getElementById('questionText').textContent = data.question;
    
    // Display players for voting with profile pictures
    const votingPlayers = document.getElementById('votingPlayers');
    votingPlayers.innerHTML = '';
    
    if (window.gamePlayers) {
        window.gamePlayers.forEach(player => {
            const card = document.createElement('div');
            card.className = 'player-vote-card';
            card.dataset.playerId = player.id;
            card.onclick = () => togglePlayerSelection(card, player.id);
            
            // Profile picture
            const profilePic = localStorage.getItem('profilePicture_' + player.id);
            if (profilePic) {
                const img = document.createElement('img');
                img.src = profilePic;
                img.className = 'vote-profile-pic';
                card.appendChild(img);
            } else {
                const placeholder = document.createElement('div');
                placeholder.className = 'vote-profile-placeholder';
                placeholder.textContent = player.username.charAt(0).toUpperCase();
                card.appendChild(placeholder);
            }
            
            // Username
            const name = document.createElement('div');
            name.className = 'vote-username';
            name.textContent = player.username;
            card.appendChild(name);
            
            votingPlayers.appendChild(card);
        });
    }
});


function togglePlayerSelection(card, playerId) {
    if (card.classList.contains('selected')) {
        card.classList.remove('selected');
        selectedPlayers = selectedPlayers.filter(id => id !== playerId);
    } else {
        if (selectedPlayers.length < 2) {
            card.classList.add('selected');
            selectedPlayers.push(playerId);
        } else {
            alert('You can only select 2 players!');
        }
    }
    
    // Enable submit button when 2 players selected
    document.getElementById('submitVoteBtn').disabled = selectedPlayers.length !== 2;
}

function submitVote() {
    if (selectedPlayers.length !== 2) {
        alert('⚠️ Please select exactly 2 players');
        return;
    }
    
    socket.emit('submitVote', {
        gameCode,
        userId: Date.now().toString(),
        votes: selectedPlayers
    });
    
    // Show waiting message with animation
    document.getElementById('questionPhase').innerHTML = `
        <div style="text-align: center; padding: 60px 20px;">
            <div class="loading" style="width: 60px; height: 60px; border-width: 5px; margin: 0 auto 30px;"></div>
            <h2 style="font-size: clamp(1.3rem, 4vw, 1.8rem); opacity: 0.9;">Waiting for other players to vote...</h2>
            <p style="opacity: 0.7; margin-top: 15px; font-size: clamp(0.95rem, 2.5vw, 1.1rem);">Your votes are locked in! 🔒</p>
        </div>
    `;
}

socket.on('resultsReady', (data) => {
    document.getElementById('questionPhase').style.display = 'none';
    document.getElementById('resultsPhase').style.display = 'block';
    
    const resultsList = document.getElementById('resultsList');
    resultsList.innerHTML = '';
    
    data.results.forEach((result, index) => {
        const item = document.createElement('div');
        item.className = 'result-item' + (index === 0 ? ' winner' : '');
        
        // Profile picture
        const player = window.gamePlayers.find(p => p.username === result.username);
        const profilePic = player ? localStorage.getItem('profilePicture_' + player.id) : null;
        
        let profileHTML = '';
        if (profilePic) {
            profileHTML = `<img src="${profilePic}" class="result-profile-pic">`;
        } else {
            profileHTML = `<div class="result-profile-placeholder">${result.username.charAt(0).toUpperCase()}</div>`;
        }
        
        item.innerHTML = `
            <div class="result-left">
                ${index === 0 ? '<div class="crown-icon">👑</div>' : ''}
                ${profileHTML}
                <span class="result-username">${result.username}</span>
            </div>
            <div class="result-right">
                <span class="result-votes">${result.votes} votes</span>
                <span class="result-percentage">${result.percentage}%</span>
            </div>
        `;
        resultsList.appendChild(item);
    });
});

function playAgain() {
    document.getElementById('resultsPhase').style.display = 'none';
    document.getElementById('waitingRoom').style.display = 'block';
    selectedPlayers = [];
    
    if (window.gamePlayers) {
        updatePlayersList(window.gamePlayers);
    }
}

// Custom Question Functions
function showAddQuestionModal() {
    document.getElementById('addQuestionModal').style.display = 'block';
    loadGameQuestions();
}

function closeQuestionModal() {
    document.getElementById('addQuestionModal').style.display = 'none';
    document.getElementById('customQuestionInput').value = '';
}

function selectQuestionType(type) {
    selectedQuestionType = type;
    document.querySelectorAll('.question-type-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    document.querySelector(`[data-type="${type}"]`).classList.add('active');
}

async function submitCustomQuestion() {
    const questionText = document.getElementById('customQuestionInput').value.trim();
    
    if (!questionText) {
        alert('⚠️ Please write a question first!');
        return;
    }
    
    const username = localStorage.getItem('username');
    
    try {
        const response = await fetch('/api/game/add-question', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                gameCode,
                type: selectedQuestionType,
                question: questionText,
                username
            })
        });
        
        const data = await response.json();
        
        if (data.success) {
            document.getElementById('customQuestionInput').value = '';
            loadGameQuestions();
            socket.emit('questionAdded', { gameCode });
        } else {
            alert('Failed to add question');
        }
    } catch (error) {
        console.error('Error adding question:', error);
        alert('Failed to add question');
    }
}

async function loadGameQuestions() {
    try {
        const response = await fetch(`/api/game/questions?gameCode=${gameCode}`);
        const data = await response.json();
        
        if (data.success) {
            customQuestions = data.questions;
            displayQuestions();
        }
    } catch (error) {
        console.error('Error loading questions:', error);
    }
}

function displayQuestions() {
    const questionsList = document.getElementById('questionsList');
    
    if (customQuestions.length === 0) {
        questionsList.innerHTML = '<p style="opacity: 0.5; text-align: center;">No questions yet. Be the first to add one!</p>';
        return;
    }
    
    const typeIcons = {
        gossip: '💬',
        question: '❓',
        dare: '🔥'
    };
    
    questionsList.innerHTML = customQuestions.map(q => `
        <div style="padding: 12px; background: rgba(255, 255, 255, 0.05); border-radius: 10px; margin-bottom: 10px; border-left: 3px solid ${q.type === 'gossip' ? '#ff0080' : q.type === 'question' ? '#00ffff' : '#ffd700'};">
            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 5px;">
                <span style="font-size: 1.2rem;">${typeIcons[q.type]}</span>
                <strong style="font-size: 0.9rem; opacity: 0.8;">${q.username}</strong>
            </div>
            <p style="font-size: 0.95rem;">${q.question}</p>
        </div>
    `).join('');
}

// Listen for new questions from other players
socket.on('questionAddedByOther', () => {
    if (document.getElementById('addQuestionModal').style.display === 'block') {
        loadGameQuestions();
    }
});
