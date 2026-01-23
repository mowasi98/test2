
// Main submission function with detached frame retry logic
async function submitToSparxNow(productName, username, password, school = '') {
  const MAX_RETRIES = 2;
  let lastError = null;
  
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log('\n' + '='.repeat(60));
      console.log(`🚀 SUBMISSION ATTEMPT ${attempt}/${MAX_RETRIES}`);
      console.log('='.repeat(60) + '\n');
      
      const result = await submitToSparxNowInternal(productName, username, password, school);
      
      console.log(`\n✅ SUBMISSION SUCCESSFUL ON ATTEMPT ${attempt}!\n`);
      return result;
      
    } catch (error) {
      lastError = error;
      const errorMsg = error.message || String(error);
      
      console.log(`\n❌ ATTEMPT ${attempt} FAILED: ${errorMsg}\n`);
      
      // Check if it's a detached frame error
      if (errorMsg.includes('detached Frame') || 
          errorMsg.includes('Execution context was destroyed') ||
          errorMsg.includes('Protocol error')) {
        
        if (attempt < MAX_RETRIES) {
          const waitTime = 3000; // Wait 3 seconds before retry
          console.log(`⏳ Detached frame detected. Waiting ${waitTime/1000}s before retry...\n`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        } else {
          console.log(`❌ All ${MAX_RETRIES} attempts failed due to detached frame errors.\n`);
        }
      } else {
        // Non-retryable error, throw immediately
        console.log(`❌ Non-retryable error encountered. Stopping attempts.\n`);
        throw error;
      }
    }
  }
  
  // All retries exhausted
  console.log(`❌ SUBMISSION FAILED AFTER ${MAX_RETRIES} ATTEMPTS\n`);
  throw lastError;
}

async function submitToSparxNowInternal(productName, username, password, school = '') {
