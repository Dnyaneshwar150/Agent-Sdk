import 'dotenv/config'
import { Agent, run, tool } from '@openai/agents'
import { z } from 'zod'
import { chromium } from 'playwright'
import fs from 'fs'

let browser = null;
let page = null;

async function getPage() {
  if (!browser) {
    browser = await chromium.launch({ headless: false })
  }
  if (!page) {
    page = await browser.newPage()
  }
  return page
}

let screenshotCounter = 0

// Helper function for ultra-slow filling
async function fillFieldSlowly(page, selector, text) {
  console.log(`    Ultra-slow fill: "${text}" into ${selector}`)
  
  // Wait and focus
  await page.waitForSelector(selector, { timeout: 10000, state: 'visible' })
  await page.waitForTimeout(1000)
  
  // Focus and clear
  await page.focus(selector)
  await page.waitForTimeout(500)
  await page.click(selector, { clickCount: 3 })
  await page.waitForTimeout(300)
  await page.keyboard.press('Delete')
  await page.waitForTimeout(500)
  
  // Type character by character
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    await page.keyboard.type(char, { delay: 150 })
    await page.waitForTimeout(200)
    
    if (i % 3 === 0) {
      const currentVal = await page.inputValue(selector)
      console.log(`      Progress: "${currentVal}"`)
    }
  }
  
  await page.waitForTimeout(1000)
  return true
}

const takeScreenShot = tool({
  name: 'take_screenshot',
  description: 'Takes a screenshot and saves it locally',
  parameters: z.object({
    format: z.enum(['png', 'jpeg']),
    quality: z.number().min(0).max(100).nullable()
  }),
  async execute({ format = 'png', quality }) {
    console.log('Taking screenshot...')
    const page = await getPage()
    screenshotCounter++

    const options = { type: format }
    if (quality !== null && quality !== undefined) {
      options.quality = quality
    }

    const buffer = await page.screenshot(options)
    const filename = `step-${screenshotCounter}.${format}`
    fs.writeFileSync(filename, buffer)
    console.log(`📸 Screenshot saved: ${filename}`)

    return { 
      success: true,
      filename: filename,
      step: screenshotCounter
    }
  }
})

const openBrowser = tool({
  name: 'open_browser',
  description: 'Opens a new browser window and navigates to URL with maximize option',
  parameters: z.object({
    url: z.string(),
    width: z.number().min(100).nullable(),
    height: z.number().min(100).nullable(),
    maximize: z.boolean().default(true).describe('Whether to maximize the browser window')
  }),
  async execute({ url, width, height, maximize = true }) {
    console.log('Opening browser...')
    if (browser) {
      await browser.close()
    }
    
    // Launch browser with maximize arguments if requested[129][133]
    const launchOptions = {
      headless: false,
      channel: "chrome"
    }
    
    if (maximize) {
      launchOptions.args = ["--start-maximized"]
      console.log('🔍 Browser will launch maximized')
    }
    
    browser = await chromium.launch(launchOptions)
    
    // Create context with null viewport for full maximization[129][133]
    const contextOptions = {}
    if (maximize) {
      contextOptions.viewport = null // This allows dynamic viewport sizing[133]
    } else if (width !== null && height !== null) {
      contextOptions.viewport = { width, height }
    }
    
    const context = await browser.newContext(contextOptions)
    page = await context.newPage()
    
    // Additional viewport setting if specific dimensions requested
    if (!maximize && width !== null && height !== null) {
      await page.setViewportSize({ width, height })
    }
    
    await page.goto(url, { waitUntil: 'networkidle' })
    
    console.log(`✅ Browser opened${maximize ? ' (maximized)' : ''} and navigated to ${url}`)
    
    return { 
      status: 'browser_opened', 
      url, 
      maximized: maximize,
      viewport: maximize ? 'dynamic' : `${width}x${height}`
    }
  }
})


const processField = tool({
  name: 'process_field',
  description: 'Process a single field: find by label, fill, verify, retry if needed',
  parameters: z.object({
    labelText: z.string().describe('The label text to find the field'),
    value: z.string().describe('Value to type into the field'),
    maxRetries: z.number().default(2).describe('Maximum retry attempts')
  }),
  async execute({ labelText, value, maxRetries = 2 }) {
    console.log(`\n=== Processing field: "${labelText}" with value: "${value}" ===`)
    const page = await getPage()
    
    try {
      // Step 1: Find the input field using the label
      console.log(`Step 1: Finding field by label "${labelText}"...`)
      
      // Find label and get its 'for' attribute or find input within same container
      let inputSelector
      try {
        // Method 1: Find label with text, then get the 'for' attribute
        const labelElement = await page.locator(`label:has-text("${labelText}")`).first()
        const forAttribute = await labelElement.getAttribute('for')
        if (forAttribute) {
          inputSelector = `#${forAttribute}`
          console.log(`  Found input by 'for' attribute: ${inputSelector}`)
        }
      } catch (error) {
        // Method 2: Find input based on common patterns
        if (labelText.includes('First Name')) inputSelector = '#firstName'
        else if (labelText.includes('Last Name')) inputSelector = '#lastName'  
        else if (labelText.includes('Email')) inputSelector = '#email'
        else if (labelText.includes('Password') && !labelText.includes('Confirm')) inputSelector = '#password'
        else if (labelText.includes('Confirm')) inputSelector = '#confirmPassword'
        console.log(`  Using fallback selector: ${inputSelector}`)
      }
      
      if (!inputSelector) {
        throw new Error(`Could not find input for label: ${labelText}`)
      }
      
      let attempt = 0
      let success = false
      
      while (attempt <= maxRetries && !success) {
        attempt++
        console.log(`\nAttempt ${attempt}/${maxRetries + 1} for "${labelText}"`)
        
        // Step 2: Fill the field using ultra-slow method
        console.log(`Step 2: Filling field ${inputSelector}...`)
        const fillResult = await fillFieldSlowly(page, inputSelector, value)
        
        // Step 3: Verify the field immediately
        console.log(`Step 3: Verifying field value...`)
        await page.waitForTimeout(1000) // Wait for value to settle
        const actualValue = await page.inputValue(inputSelector)
        
        if (actualValue === value) {
          console.log(`✅ SUCCESS: "${labelText}" correctly filled with "${actualValue}"`)
          success = true
        } else {
          console.log(`❌ MISMATCH: "${labelText}" expected "${value}" but got "${actualValue}"`)
          if (attempt <= maxRetries) {
            console.log(`  Retrying in 2 seconds...`)
            await page.waitForTimeout(2000)
          }
        }
      }
      
      return {
        success,
        labelText,
        inputSelector,
        expectedValue: value,
        actualValue: await page.inputValue(inputSelector),
        attempts: attempt
      }
      
    } catch (error) {
      console.log(`❌ ERROR processing field "${labelText}": ${error.message}`)
      return { success: false, error: error.message, labelText }
    }
  }
})

const verifyAndRetryField = tool({
  name: 'verify_and_retry_field',
  description: 'Verify a field and retry filling if verification fails',
  parameters: z.object({
    selector: z.string().describe('CSS selector for the input field'),
    expectedValue: z.string().describe('The expected value'),
    labelName: z.string().describe('Human readable field name')
  }),
  async execute({ selector, expectedValue, labelName }) {
    console.log(`\n--- Verifying "${labelName}" field ---`)
    const page = await getPage()
    
    try {
      await page.waitForSelector(selector, { timeout: 5000, state: 'visible' })
      const actualValue = await page.inputValue(selector)
      
      if (actualValue === expectedValue) {
        console.log(`✅ VERIFIED: ${labelName} = "${actualValue}"`)
        return { success: true, selector, expectedValue, actualValue, fieldName: labelName }
      } else {
        console.log(`❌ VERIFICATION FAILED: ${labelName}`)
        console.log(`   Expected: "${expectedValue}"`)
        console.log(`   Actual:   "${actualValue}"`)
        console.log(`   Attempting one retry...`)
        
        // One retry attempt
        await fillFieldSlowly(page, selector, expectedValue)
        await page.waitForTimeout(1000)
        
        const retryValue = await page.inputValue(selector)
        const retrySuccess = retryValue === expectedValue
        
        console.log(`   Retry result: ${retrySuccess ? '✅ SUCCESS' : '❌ FAILED'}`)
        console.log(`   Final value: "${retryValue}"`)
        
        return { 
          success: retrySuccess, 
          selector, 
          expectedValue, 
          actualValue: retryValue, 
          fieldName: labelName,
          wasRetried: true 
        }
      }
    } catch (error) {
      console.log(`❌ ERROR verifying ${labelName}: ${error.message}`)
      return { success: false, error: error.message, fieldName: labelName }
    }
  }
})

const verifyFormData = tool({
  name: 'verify_form_data',
  description: 'Verifies all form fields have correct values',
  parameters: z.object({
    firstName: z.string(),
    lastName: z.string(),
    email: z.string(),
    password: z.string(),
    confirmPassword: z.string()
  }),
  async execute({ firstName, lastName, email, password, confirmPassword }) {
    console.log('\n🔍 Verifying all form fields...')
    const page = await getPage()
    
    const fieldChecks = [
      { selector: '#firstName', expected: firstName, name: 'First Name' },
      { selector: '#lastName', expected: lastName, name: 'Last Name' },
      { selector: '#email', expected: email, name: 'Email' },
      { selector: '#password', expected: password, name: 'Password' },
      { selector: '#confirmPassword', expected: confirmPassword, name: 'Confirm Password' }
    ]
    
    const results = []
    let allPassed = true
    
    for (const check of fieldChecks) {
      try {
        const actualValue = await page.inputValue(check.selector)
        const passed = actualValue === check.expected
        
        if (passed) {
          console.log(`✅ ${check.name}: "${actualValue}" ✓`)
        } else {
          console.log(`❌ ${check.name}: Expected "${check.expected}", got "${actualValue}"`)
          allPassed = false
        }
        
        results.push({
          field: check.name,
          selector: check.selector,
          expected: check.expected,
          actual: actualValue,
          passed
        })
      } catch (error) {
        console.log(`❌ ${check.name}: Error - ${error.message}`)
        results.push({
          field: check.name,
          selector: check.selector,
          expected: check.expected,
          actual: null,
          passed: false,
          error: error.message
        })
        allPassed = false
      }
    }
    
    console.log(`\n📊 Form Verification Summary: ${results.filter(r => r.passed).length}/${results.length} fields correct`)
    
    return {
      success: allPassed,
      allFieldsPassed: allPassed,
      results,
      summary: `${results.filter(r => r.passed).length}/${results.length} fields correct`
    }
  }
})

const clickElement = tool({
  name: 'click_element',
  description: 'Clicks on an element using CSS selector',
  parameters: z.object({
    selector: z.string().describe('CSS selector for the element to click')
  }),
  async execute({ selector }) {
    console.log(`\n🖱️ Attempting to click: ${selector}`)
    const page = await getPage()
    
    try {
      await page.waitForSelector(selector, { timeout: 10000, state: 'visible' })
      await page.click(selector)
      
      console.log(`✅ Successfully clicked ${selector}`)
      return { success: true, clicked: selector }
    } catch (error) {
      console.log(`❌ Failed to click ${selector}: ${error.message}`)
      return { success: false, error: error.message, selector }
    }
  }
})

const websiteAutomationAgent = new Agent({
  name: 'website_automation_agent',
  model: 'gpt-4o',
  instructions: `
You are a methodical website automation agent. Follow this EXACT step-by-step process:

PHASE 1: SETUP
1. Use open_browser to navigate to the signup URL with maximize=true
2. Take screenshot to see the initial page

PHASE 2: FIELD-BY-FIELD PROCESSING
For each field, follow this pattern:
3. Use process_field for "First Name" with value "Dnyaneshwar"
4. Use verify_and_retry_field to verify firstName field (#firstName)
5. Use process_field for "Last Name" with value "Dimble"  
6. Use verify_and_retry_field to verify lastName field (#lastName)
7. Use process_field for "Email" with value "mavi@example.com"
8. Use verify_and_retry_field to verify email field (#email)
9. Use process_field for "Password" with value "mySecret123"
10. Use verify_and_retry_field to verify password field (#password)
11. Use process_field for "Confirm Password" with value "mySecret123"
12. Use verify_and_retry_field to verify confirmPassword field (#confirmPassword)

PHASE 3: FINAL VALIDATION
13. Use verify_form_data to check ALL fields are correct with these values:
    firstName: "Dnyaneshwar", lastName: "Dimble", email: "mavi@example.com", 
    password: "mySecret123", confirmPassword: "mySecret123"
14. Take screenshot showing completed form
15. ONLY if verify_form_data passes, use click_element with selector "button[type='submit']"
16. Take final screenshot

CRITICAL RULES:
- Process ONE field at a time
- Verify each field immediately after filling
- Retry failed fields once
- Only submit if ALL verifications pass
- Always use the process_field tool first, then verify_and_retry_field
- Use exact field selectors: #firstName, #lastName, #email, #password, #confirmPassword
`,
  tools: [takeScreenShot, openBrowser, processField, verifyAndRetryField, verifyFormData, clickElement]
})

async function main() {
  try {
    console.log('\n🚀 Starting Step-by-Step Form Automation...\n')
    
    const result = await run(
      websiteAutomationAgent,
      `Navigate to https://ui.chaicode.com/auth/signup and create an account using this methodical approach:

STEP-BY-STEP FIELD PROCESSING:
1. Process "First Name" field with "Dnyaneshwar" 
2. Verify firstName field (#firstName) has exactly "Dnyaneshwar"
3. Process "Last Name" field with "Dimble"
4. Verify lastName field (#lastName) has exactly "Dimble"  
5. Process "Email" field with "mavi@example.com"
6. Verify email field (#email) has exactly "mavi@example.com"
7. Process "Password" field with "mySecret123"
8. Verify password field (#password) has exactly "mySecret123"
9. Process "Confirm Password" field with "mySecret123" 
10. Verify confirmPassword field (#confirmPassword) has exactly "mySecret123"

FINAL VALIDATION:
11. Verify ALL form data is correct using verify_form_data
12. Take screenshot showing completed form
13. ONLY submit if all verifications pass by clicking button[type="submit"]

Use process_field for filling and verify_and_retry_field for verification. Retry any failed fields once before proceeding.`
    )
    
    console.log('\n✅ Automation completed successfully!')
    console.log('Final result:', result)
    
  } catch (error) {
    console.error('\n❌ Automation failed:', error)
  } finally {
    if (browser) {
      console.log('\n🔒 Closing browser...')
      await browser.close()
    }
  }
}

main().catch(console.error)
