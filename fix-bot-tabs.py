#!/usr/bin/env python3
"""
Fix discord-browser-bot-download.js to use product tabs instead of global page
"""

import re

# Read the file
with open('discord-browser-bot-download.js', 'r', encoding='utf-8') as f:
    content = f.read()

# Find the submitToSparxNowInternal function
# We'll replace all 'page.' with 'productPage.' within this function only

# Find function start
func_start = content.find('// Internal submission function (can retry if frame detaches)')
if func_start == -1:
    func_start = content.find('async function submitToSparxNowInternal(')

# Find function end (next function or module.exports)
func_end = content.find('// API endpoints for Express server', func_start)
if func_end == -1:
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

# Replace all instances of 'page.' with 'productPage.' in the function
# But NOT in comments or strings about "page"
replacements = [
    ('await page.evaluate', 'await productPage.evaluate'),
    ('await page.goto', 'await productPage.goto'),
    ('await page.screenshot', 'await productPage.screenshot'),
    ('await page.waitForSelector', 'await productPage.waitForSelector'),
    ('await page.waitForFunction', 'await productPage.waitForFunction'),
    ('await page.keyboard', 'await productPage.keyboard'),
    ('await page.type', 'await productPage.type'),
    ('await page.click', 'await productPage.click'),
    ('await page.evaluateHandle', 'await productPage.evaluateHandle'),
    (' page.evaluate', ' productPage.evaluate'),
    (' page.goto', ' productPage.goto'),
    (' page.screenshot', ' productPage.screenshot'),
    (' page.waitForSelector', ' productPage.waitForSelector'),
    (' page.waitForFunction', ' productPage.waitForFunction'),
    (' page.keyboard', ' productPage.keyboard'),
    (' page.type', ' productPage.type'),
    (' page.click', ' productPage.click'),
    (' page.evaluateHandle', ' productPage.evaluateHandle'),
]

for old, new in replacements:
    count = func_content.count(old)
    if count > 0:
        func_content = func_content.replace(old, new)
        print(f"Replaced '{old}' -> '{new}' ({count} times)")

# Reassemble the file
new_content = before_func + func_content + after_func

# Write back
with open('discord-browser-bot-download.js', 'w', encoding='utf-8') as f:
    f.write(new_content)

print("\nFile updated successfully!")
print("All 'page' references in submitToSparxNowInternal replaced with 'productPage'")
