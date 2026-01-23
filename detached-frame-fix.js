// ============================================
// COMPREHENSIVE FIX FOR DETACHED FRAME ERRORS
// Add these functions to discord-browser-bot.js
// ============================================

// Helper function: Safely execute page.evaluate with retry logic
async function safePageEvaluate(page, evalFunction, maxRetries = 3, functionName = "operation") {
  let lastError = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`🔄 [${functionName}] Attempt ${attempt}/${maxRetries}`);
      const result = await evalFunction();
      console.log(`✅ [${functionName}] Success on attempt ${attempt}`);
      return result;
    } catch (error) {
      lastError = error;
      const errorMsg = error.message || String(error);
      
      // Check if it's a detached frame error
      if (errorMsg.includes('detached Frame') || errorMsg.includes('Execution context was destroyed')) {
        console.log(`⚠️ [${functionName}] Frame detached on attempt ${attempt}`);
        
        if (attempt < maxRetries) {
          const waitTime = Math.pow(2, attempt - 1) * 1000; // 1s, 2s, 4s
          console.log(`⏳ [${functionName}] Waiting ${waitTime/1000}s before retry...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
          
          // Check if page is still valid
          try {
            await page.evaluate(() => true);
            console.log(`✅ [${functionName}] Page is responsive, retrying...`);
          } catch (e) {
            console.log(`❌ [${functionName}] Page is dead, needs reinitialization`);
            throw new Error('Page completely detached - requires full restart');
          }
        }
      } else {
        // Different error, don't retry
        console.log(`❌ [${functionName}] Non-retryable error: ${errorMsg}`);
        throw error;
      }
    }
  }
  
  // All retries failed
  console.log(`❌ [${functionName}] All ${maxRetries} attempts failed`);
  throw lastError;
}

// Example of wrapping a page.evaluate call:
// BEFORE:
//   const result = await page.evaluate(() => {
//     // some code
//     return something;
//   });
//
// AFTER:
//   const result = await safePageEvaluate(
//     page,
//     async () => await page.evaluate(() => {
//       // some code
//       return something;
//     }),
//     3,
//     "descriptive-name"
//   );
