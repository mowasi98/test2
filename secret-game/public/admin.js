// Admin dashboard JavaScript
const ADMIN_PASSWORD = 'Wasishah98';

// Check admin password
function checkAdminPassword(event) {
    event.preventDefault();
    const password = document.getElementById('adminPassword').value;
    const errorMsg = document.getElementById('adminLoginError');
    
    if (password === ADMIN_PASSWORD) {
        // Store admin session
        sessionStorage.setItem('adminAuthenticated', 'true');
        document.getElementById('adminLogin').style.display = 'none';
        document.getElementById('adminDashboard').style.display = 'block';
        loadAdminData();
    } else {
        errorMsg.textContent = '❌ Incorrect password. Access denied.';
        document.getElementById('adminPassword').value = '';
    }
}

// Check if admin is already authenticated
window.addEventListener('DOMContentLoaded', () => {
    const isAuthenticated = sessionStorage.getItem('adminAuthenticated');
    if (isAuthenticated === 'true') {
        document.getElementById('adminLogin').style.display = 'none';
        document.getElementById('adminDashboard').style.display = 'block';
        loadAdminData();
    }
});

// Load data on page load

async function loadAdminData() {
    try {
        const response = await fetch('/api/admin/games');
        const data = await response.json();
        
        displayStats(data.games);
        displayGames(data.games);
    } catch (error) {
        console.error('Error loading admin data:', error);
    }
}

function displayStats(games) {
    const activeGames = games.length;
    let totalPlayers = 0;
    let totalVotes = 0;
    let totalSpins = 0;
    
    games.forEach(game => {
        totalPlayers += game.playerCount;
        totalVotes += Object.keys(game.votes).length;
        if (game.spinHistory) totalSpins += game.spinHistory.length;
    });
    
    document.getElementById('activeGames').textContent = activeGames;
    document.getElementById('totalPlayers').textContent = totalPlayers;
    document.getElementById('totalVotes').textContent = totalVotes;
    document.getElementById('totalSpins').textContent = totalSpins;
}


function displayGames(games) {
    const gamesList = document.getElementById('gamesList');
    gamesList.innerHTML = '';
    
    if (games.length === 0) {
        gamesList.innerHTML = '<p style="text-align: center; opacity: 0.7; padding: 40px;">No active games</p>';
        return;
    }
    
    games.forEach(game => {
        const gameItem = document.createElement('div');
        gameItem.className = 'game-item';
        
        // Find who created the game (first player)
        const creator = game.players[0] ? game.players[0].username : 'Unknown';
        
        // Build answers section - show who voted for whom for each question
        let answersHTML = '';
        if (Object.keys(game.votes).length > 0) {
            answersHTML = '<div style="margin-top: 20px;"><h4 style="color: #ff0080; margin-bottom: 15px;">📊 Answers & Results:</h4>';
            
            // Current question
            if (game.currentQuestion) {
                answersHTML += `<div style="background: rgba(255, 0, 128, 0.1); padding: 15px; border-radius: 12px; margin-bottom: 15px; border-left: 4px solid #ff0080;">
                    <strong style="font-size: 1.1rem;">Question:</strong> ${game.currentQuestion}
                </div>`;
            }
            
            // Show each player's votes
            for (let [userId, votes] of Object.entries(game.votes)) {
                const player = game.players.find(p => p.id === userId);
                const playerName = player ? player.username : 'Unknown';
                
                // Get names of who they voted for
                const votedPlayers = votes.map(vId => {
                    const vp = game.players.find(p => p.id === vId);
                    return vp ? vp.username : 'Unknown';
                });
                
                answersHTML += `
                    <div class="vote-detail" style="background: rgba(0, 255, 255, 0.05); padding: 12px; border-radius: 8px; margin-bottom: 10px; border-left: 3px solid #00ffff;">
                        <strong style="color: #00ffff;">${playerName}</strong> voted for: 
                        <span style="color: #ffd700;">${votedPlayers.join(', ')}</span>
                    </div>
                `;
            }
            
            // Calculate and show vote tally
            const voteCount = {};
            Object.values(game.votes).forEach(votes => {
                votes.forEach(votedId => {
                    voteCount[votedId] = (voteCount[votedId] || 0) + 1;
                });
            });
            
            if (Object.keys(voteCount).length > 0) {
                answersHTML += '<div style="margin-top: 15px; padding: 15px; background: rgba(255, 215, 0, 0.1); border-radius: 10px; border-left: 4px solid #ffd700;"><strong style="color: #ffd700;">Vote Totals:</strong><br>';
                
                // Sort by vote count
                const sorted = Object.entries(voteCount).sort((a, b) => b[1] - a[1]);
                sorted.forEach(([playerId, count], index) => {
                    const player = game.players.find(p => p.id === playerId);
                    const name = player ? player.username : 'Unknown';
                    const percentage = ((count / Object.keys(game.votes).length) * 100).toFixed(0);
                    const trophy = index === 0 ? '👑 ' : '';
                    
                    answersHTML += `<div style="margin: 8px 0;">${trophy}<strong>${name}</strong>: ${count} vote${count > 1 ? 's' : ''} (${percentage}%)</div>`;
                });
                answersHTML += '</div>';
            }
            
            answersHTML += '</div>';
        }
        
        // Wheel spins section
        let spinHTML = '';
        if (game.spinHistory && game.spinHistory.length > 0) {
            spinHTML = '<div style="margin-top: 20px;"><h4 style="color: #ff0080; margin-bottom: 10px;">🎰 Wheel Spins:</h4>';
            game.spinHistory.forEach((spin, index) => {
                spinHTML += `
                    <div class="vote-detail" style="background: rgba(255, 0, 128, 0.05); padding: 10px; border-radius: 8px; margin-bottom: 8px;">
                        ${index + 1}. <strong>${spin.username}</strong> at ${new Date(spin.time).toLocaleTimeString()}
                    </div>
                `;
            });
            spinHTML += '</div>';
        }
        
        gameItem.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 15px;">
                <div>
                    <h3 style="margin: 0; font-size: 1.5rem;">🎮 ${game.code}</h3>
                    <p style="margin: 5px 0; opacity: 0.8;"><strong>Category:</strong> <span style="color: #ff0080; text-transform: capitalize;">${game.category}</span></p>
                </div>
                <div style="text-align: right; opacity: 0.7; font-size: 0.9rem;">
                    ${new Date(game.createdAt).toLocaleString()}
                </div>
            </div>
            
            <div style="background: rgba(0, 255, 255, 0.1); padding: 12px; border-radius: 10px; margin-bottom: 15px;">
                <p style="margin: 5px 0;"><strong>Created by:</strong> <span style="color: #00ffff;">${creator}</span></p>
                <p style="margin: 5px 0;"><strong>Players (${game.playerCount}):</strong> ${game.players.map(p => p.username).join(', ')}</p>
            </div>
            
            ${answersHTML}
            ${spinHTML}
        `;
        
        gamesList.appendChild(gameItem);
    });
}

function refreshData() {
    loadAdminData();
}

// Auto-refresh every 5 seconds
setInterval(loadAdminData, 5000);
