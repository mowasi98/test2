#!/usr/bin/env python3
"""
Fix discord-browser-bot-download.js to use single tab (page) instead of productPage
"""

import re

# Read the file
with open('discord-browser-bot-download.js', 'r', encoding='utf-8') as f:
    content = f.read()

# Find the submitToSparxNowInternal function
func_start = content.find('// Internal submission function (can retry if frame detaches)')
if func_start == -1:
    func_start = content.find('async function submitToSparxNowInternal(')

# Find function end
func_end = content.find('module.exports =', func_start)

if func_start == -1 or func_end == -1:
    print("Could not find function boundaries")
    exit(1)

# Extract function content
before_func = content[:func_start]
func_content = content[func_start:func_end]
after_func = content[func_end:]

print(f"Found function at {func_start}:{func_end}")
print(f"Function length: {len(func_content)} characters")

# Replace all productPage with page
replacements = [
    ('productPage.evaluate', 'page.evaluate'),
    ('productPage.goto', 'page.goto'),
    ('productPage.screenshot', 'page.screenshot'),
    ('productPage.waitForSelector', 'page.waitForSelector'),
    ('productPage.waitForFunction', 'page.waitForFunction'),
    ('productPage.keyboard', 'page.keyboard'),
    ('productPage.type', 'page.type'),
    ('productPage.click', 'page.click'),
    ('productPage.evaluateHandle', 'page.evaluateHandle'),
]

for old, new in replacements:
    count = func_content.count(old)
    if count > 0:
        func_content = func_content.replace(old, new)
        print(f"Replaced '{old}' -> '{new}' ({count} times)")

# Remove the "Get or create product tab" section
tab_section_start = func_content.find('// Get or create the product-specific tab')
tab_section_end = func_content.find('console.log(`🔍 Navigating "${productName}" tab to channel...`);')

if tab_section_start != -1 and tab_section_end != -1:
    # Keep everything before the tab section
    before_tab = func_content[:tab_section_start]
    # Keep everything from the navigation log onwards
    after_tab = func_content[tab_section_end:]
    
    # Combine without the tab section
    func_content = before_tab + after_tab
    print("Removed product tab creation section")

# Remove the 5-minute confirmation wait section
wait_section_start = func_content.find('// Wait for confirmation message')
wait_section_end = func_content.find("console.log('✅ Submission complete!");

if wait_section_start != -1 and wait_section_end != -1:
    # Keep everything before the wait section
    before_wait = func_content[:wait_section_start]
    # Keep everything from the completion log onwards
    after_wait = func_content[wait_section_end:]
    
    # Combine and add immediate completion log
    func_content = before_wait + "// No confirmation wait - submission complete immediately\n    console.log('✅ Submission complete!" + after_wait[after_wait.find("'✅ Submission complete!") + len("'✅ Submission complete!"):]
    print("Removed 5-minute confirmation wait section")

# Reassemble the file
new_content = before_func + func_content + after_func

# Write back
with open('discord-browser-bot-download.js', 'w', encoding='utf-8') as f:
    f.write(new_content)

print("\nFile updated successfully!")
print("All 'productPage' references replaced with 'page'")
print("Product tab creation section removed")
