// Main page JavaScript

// Check if user is logged in
function checkAuth() {
    const loggedIn = localStorage.getItem('loggedIn');
    const username = localStorage.getItem('username');
    
    if (!loggedIn || loggedIn !== 'true' || !username) {
        window.location.href = '/login';
        return false;
    }
    return true;
}

// Check auth on page load
window.addEventListener('DOMContentLoaded', () => {
    if (!checkAuth()) return;
    
    const username = localStorage.getItem('username');
    const userId = localStorage.getItem('userId');
    
    if (username) {
        const tagline = document.querySelector('.tagline');
        if (tagline) {
            tagline.textContent = `Welcome back, ${username}! 👋`;
        }
        
        // Update user bar at top
        updateUserBar();
    }
});

function updateUserBar() {
    const username = localStorage.getItem('username');
    const userId = localStorage.getItem('userId');
    const profilePic = localStorage.getItem('profilePicture_' + userId);
    
    const userNameEl = document.getElementById('userName');
    const userProfilePic = document.getElementById('userProfilePic');
    const userProfilePlaceholder = document.getElementById('userProfilePlaceholder');
    
    if (userNameEl) {
        userNameEl.textContent = username;
    }
    
    if (profilePic) {
        userProfilePic.src = profilePic;
        userProfilePic.style.display = 'block';
        userProfilePlaceholder.style.display = 'none';
    } else {
        userProfilePlaceholder.textContent = username.charAt(0).toUpperCase();
        userProfilePlaceholder.style.display = 'flex';
        userProfilePic.style.display = 'none';
    }
}

// Profile Options
function showProfileOptions() {
    document.getElementById('profileOptionsModal').style.display = 'block';
}

function closeProfileOptions() {
    document.getElementById('profileOptionsModal').style.display = 'none';
}

// Change Photo
let selectedNewPhotoData = null;

function changePhoto() {
    closeProfileOptions();
    document.getElementById('changePhotoModal').style.display = 'block';
}

function closeChangePhoto() {
    document.getElementById('changePhotoModal').style.display = 'none';
    document.getElementById('photoPreviewChange').style.display = 'none';
    selectedNewPhotoData = null;
}

function openCameraForChange() {
    document.getElementById('cameraInputChange').click();
}

function selectFromGalleryForChange() {
    document.getElementById('galleryInputChange').click();
}

function handlePhotoChange(event) {
    const file = event.target.files[0];
    if (file) {
        const reader = new FileReader();
        reader.onload = function(e) {
            selectedNewPhotoData = e.target.result;
            document.getElementById('previewImageChange').src = selectedNewPhotoData;
            document.getElementById('photoPreviewChange').style.display = 'block';
        };
        reader.readAsDataURL(file);
    }
}

function confirmPhotoChange() {
    if (selectedNewPhotoData) {
        const userId = localStorage.getItem('userId');
        localStorage.setItem('profilePicture_' + userId, selectedNewPhotoData);
        closeChangePhoto();
        updateUserBar();
        alert('✅ Profile photo updated successfully!');
    }
}

// Change Username
function changeUsername() {
    closeProfileOptions();
    const currentUsername = localStorage.getItem('username');
    document.getElementById('currentUsername').textContent = currentUsername;
    document.getElementById('newUsernameInput').value = '';
    document.getElementById('changeUsernameModal').style.display = 'block';
}

function closeChangeUsername() {
    document.getElementById('changeUsernameModal').style.display = 'none';
}

function confirmUsernameChange() {
    const newUsername = document.getElementById('newUsernameInput').value.trim();
    
    if (!newUsername) {
        alert('⚠️ Please enter a username');
        return;
    }
    
    if (newUsername.length < 2) {
        alert('⚠️ Username must be at least 2 characters');
        return;
    }
    
    if (newUsername.length > 20) {
        alert('⚠️ Username must be less than 20 characters');
        return;
    }
    
    // Save new username
    localStorage.setItem('username', newUsername);
    
    // Update display
    closeChangeUsername();
    updateUserBar();
    
    // Update tagline
    const tagline = document.querySelector('.tagline');
    if (tagline) {
        tagline.textContent = `Welcome back, ${newUsername}! 👋`;
    }
    
    alert('✅ Username updated successfully!');
}

function showCreateGame() {
    if (!checkAuth()) return;
    document.getElementById('createGameModal').style.display = 'block';
}

function showJoinGame() {
    if (!checkAuth()) return;
    document.getElementById('joinGameModal').style.display = 'block';
}

function closeModals() {
    document.getElementById('createGameModal').style.display = 'none';
    document.getElementById('joinGameModal').style.display = 'none';
}

function createGameMode(category) {
    if (!checkAuth()) return;
    closeModals();
    createGame(category);
}

async function createGame(category) {
    try {
        const response = await fetch('/api/game/create', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ category })
        });
        
        const data = await response.json();
        
        if (data.success) {
            sessionStorage.setItem('gameCode', data.gameCode);
            sessionStorage.setItem('category', category);
            sessionStorage.setItem('isAdmin', 'true');
            window.location.href = '/game';
        } else {
            alert(data.error || 'Failed to create game. Please login first.');
            window.location.href = '/login';
        }
    } catch (error) {
        console.error('Error creating game:', error);
        alert('Failed to create game. Please login first.');
        window.location.href = '/login';
    }
}

async function joinGame() {
    const gameCode = document.getElementById('gameCodeInput').value.trim().toUpperCase();
    
    if (!gameCode) {
        alert('Please enter a game code');
        return;
    }
    
    try {
        const response = await fetch('/api/game/join', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ gameCode })
        });
        
        const data = await response.json();
        
        if (data.success) {
            sessionStorage.setItem('gameCode', gameCode);
            sessionStorage.setItem('category', data.game.category);
            sessionStorage.setItem('isAdmin', 'false');
            window.location.href = '/game';
        } else {
            alert(data.error || 'Failed to join game');
        }
    } catch (error) {
        console.error('Error joining game:', error);
        alert('Failed to join game. Please login first.');
        window.location.href = '/login';
    }
}

function logout() {
    // Clear all user data
    const userId = localStorage.getItem('userId');
    
    localStorage.removeItem('loggedIn');
    localStorage.removeItem('username');
    localStorage.removeItem('userId');
    localStorage.removeItem('userEmail');
    localStorage.removeItem('loginTimestamp');
    
    // Optionally keep profile picture for next login
    // If you want to remove it too, uncomment this:
    // if (userId) localStorage.removeItem('profilePicture_' + userId);
    
    window.location.href = '/login';
}

// Close modal when clicking outside
window.onclick = function(event) {
    const createModal = document.getElementById('createGameModal');
    const joinModal = document.getElementById('joinGameModal');
    
    if (event.target == createModal) {
        createModal.style.display = 'none';
    }
    if (event.target == joinModal) {
        joinModal.style.display = 'none';
    }
}
