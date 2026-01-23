// Authentication JavaScript

function showLogin() {
    document.getElementById('loginForm').style.display = 'block';
    document.getElementById('registerForm').style.display = 'none';
    document.querySelectorAll('.tab-btn')[0].classList.add('active');
    document.querySelectorAll('.tab-btn')[1].classList.remove('active');
}

function showRegister() {
    document.getElementById('loginForm').style.display = 'none';
    document.getElementById('registerForm').style.display = 'block';
    document.querySelectorAll('.tab-btn')[0].classList.remove('active');
    document.querySelectorAll('.tab-btn')[1].classList.add('active');
}

// Social Login Functions
function loginWithGoogle() {
    alert('🚀 Google Sign-In Coming Soon!\n\nFor now, please use email/password registration.');
    // TODO: Implement Google OAuth
    // window.location.href = '/auth/google';
}

function loginWithApple() {
    alert('🍎 Apple Sign-In Coming Soon!\n\nFor now, please use email/password registration.');
    // TODO: Implement Apple OAuth
    // window.location.href = '/auth/apple';
}

function loginWithMicrosoft() {
    alert('🪟 Microsoft Sign-In Coming Soon!\n\nFor now, please use email/password registration.');
    // TODO: Implement Microsoft OAuth
    // window.location.href = '/auth/microsoft';
}

// Profile Picture Functions
let selectedPhotoData = null;

function showProfilePictureModal() {
    document.getElementById('profilePictureModal').style.display = 'block';
}

function openCamera() {
    document.getElementById('cameraInput').click();
}

function selectFromGallery() {
    document.getElementById('galleryInput').click();
}

function handlePhotoSelected(event) {
    const file = event.target.files[0];
    if (file) {
        const reader = new FileReader();
        reader.onload = function(e) {
            selectedPhotoData = e.target.result;
            document.getElementById('previewImage').src = selectedPhotoData;
            document.getElementById('photoPreview').style.display = 'block';
        };
        reader.readAsDataURL(file);
    }
}

function confirmPhoto() {
    if (selectedPhotoData) {
        const userId = localStorage.getItem('userId');
        localStorage.setItem('profilePicture_' + userId, selectedPhotoData);
        document.getElementById('profilePictureModal').style.display = 'none';
        window.location.href = '/';
    }
}

function isValidEmail(email) {
    // Check for @ symbol and valid domain
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
        return false;
    }
    
    // Check if email contains @ and has a domain extension
    if (!email.includes('@')) {
        return false;
    }
    
    const parts = email.split('@');
    if (parts.length !== 2) {
        return false;
    }
    
    const domain = parts[1];
    // Check for domain extension (.com, .org, .net, etc.)
    if (!domain.includes('.') || domain.split('.').pop().length < 2) {
        return false;
    }
    
    return true;
}

async function login(event) {
    event.preventDefault();
    
    const email = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;
    const errorMsg = document.getElementById('loginError');
    
    if (!email || !password) {
        errorMsg.textContent = '⚠️ Please fill in all fields';
        return;
    }
    
    if (!isValidEmail(email)) {
        errorMsg.textContent = '⚠️ Please enter a valid email (e.g., name@example.com)';
        return;
    }
    
    errorMsg.textContent = '';
    
    try {
        const response = await fetch('/api/login', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ email, password })
        });
        
        const data = await response.json();
        
        if (response.ok && data.success) {
            // Save login info permanently
            localStorage.setItem('username', data.username);
            localStorage.setItem('userId', data.userId);
            localStorage.setItem('userEmail', data.email || email);
            localStorage.setItem('loggedIn', 'true');
            localStorage.setItem('loginTimestamp', Date.now());
            
            // Check if user has profile picture
            const hasProfilePic = localStorage.getItem('profilePicture_' + data.userId);
            if (!hasProfilePic) {
                showProfilePictureModal();
            } else {
                window.location.href = '/';
            }
        } else {
            errorMsg.textContent = '❌ ' + (data.error || 'Invalid email or password');
        }
    } catch (error) {
        console.error('Login error:', error);
        errorMsg.textContent = '❌ Connection error. Please try again.';
    }
}

async function register(event) {
    event.preventDefault();
    
    const username = document.getElementById('registerUsername').value.trim();
    const email = document.getElementById('registerEmail').value.trim();
    const password = document.getElementById('registerPassword').value;
    const errorMsg = document.getElementById('registerError');
    
    if (!username || !email || !password) {
        errorMsg.textContent = '⚠️ Please fill in all fields';
        return;
    }
    
    if (!isValidEmail(email)) {
        errorMsg.textContent = '⚠️ Email must contain @ and a valid domain (e.g., .com, .org)';
        return;
    }
    
    if (password.length < 6) {
        errorMsg.textContent = '⚠️ Password must be at least 6 characters';
        return;
    }
    
    errorMsg.textContent = '';
    
    try {
        const response = await fetch('/api/register', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ username, email, password })
        });
        
        const data = await response.json();
        
        if (response.ok && data.success) {
            // Save registration info permanently
            localStorage.setItem('username', data.username);
            localStorage.setItem('userId', data.userId);
            localStorage.setItem('userEmail', data.email || email);
            localStorage.setItem('loggedIn', 'true');
            localStorage.setItem('loginTimestamp', Date.now());
            
            // Show profile picture modal for new users
            showProfilePictureModal();
        } else {
            errorMsg.textContent = '❌ ' + (data.error || 'Registration failed');
        }
    } catch (error) {
        console.error('Registration error:', error);
        errorMsg.textContent = '❌ Connection error. Please try again.';
    }
}
