import 'dotenv/config'
import { Agent, run, tool } from '@openai/agents'
import { z } from 'zod'
import { chromium } from 'playwright'
import fs from 'fs'

let browser = null;
let page = null;
let screenshotCounter = 0;

// ================================
// PAGE CONFIGURATION SYSTEM
// ================================

const PAGE_DEFINITIONS = {
  signup: {
    url: 'https://ui.chaicode.com/auth/signup',
    name: 'Sign Up',
    fields: [
      { label: 'First Name', selector: '#firstName', type: 'text', required: true },
      { label: 'Last Name', selector: '#lastName', type: 'text', required: true },
      { label: 'Email', selector: '#email', type: 'email', required: true },
      { label: 'Password', selector: '#password', type: 'password', required: true },
      { label: 'Confirm Password', selector: '#confirmPassword', type: 'password', required: true }
    ],
    submitSelector: 'button[type="submit"]',
    submitText: 'Create Account'
  },
  login: {
    url: 'https://ui.chaicode.com/auth/login',
    name: 'Login',
    fields: [
      { label: 'Email', selector: '#email', type: 'email', required: true },
      { label: 'Password', selector: '#password', type: 'password', required: true }
    ],
    submitSelector: 'button[type="submit"]',
    submitText: 'Sign In'
  },
  'forgot-password': {
    url: 'https://ui.chaicode.com/auth/forgot-password',
    name: 'Forgot Password',
    fields: [
      { label: 'Email', selector: '#email', type: 'email', required: true }
    ],
    submitSelector: 'button[type="submit"]',
    submitText: 'Send Reset Link'
  },
  'verify-otp': {
    url: 'https://ui.chaicode.com/auth/verify-otp',
    name: 'Verify OTP',
    fields: [
      { label: 'OTP Code', selector: '#otp', type: 'text', required: true }
    ],
    submitSelector: 'button[type="submit"]',
    submitText: 'Verify'
  },
  'password-reset': {
    url: 'https://ui.chaicode.com/auth/password-reset',
    name: 'Password Reset',
    fields: [
      { label: 'New Password', selector: '#password', type: 'password', required: true },
      { label: 'Confirm Password', selector: '#confirmPassword', type: 'password', required: true }
    ],
    submitSelector: 'button[type="submit"]',
    submitText: 'Reset Password'
  }
}

const DEFAULT_VALUES = {
  firstName: 'Dnyaneshwar',
  lastName: 'Dimble',
  email: 'dnyaneshwardimble25436@gmail.com',
  password: 'mySecret123',
  confirmPassword: 'mySecret123',
  otp: '123456'
}

// ================================
// HELPER FUNCTIONS
// ================================

async function getPage() {
  if (!browser) {
    browser = await chromium.launch({ 
      headless: false,
      channel: "chrome",
      // args: ["--start-maximized"]
    })
  }
  if (!page) {
    const context = await browser.newContext({ viewport: null })
    page = await context.newPage()
  }
  return page
}

async function fillFieldSlowly(page, selector, text) {
  console.log(`    Ultra-slow fill: "${text}" into ${selector}`)
  
  await page.waitForSelector(selector, { timeout: 10000, state: 'visible' })
  await page.waitForTimeout(500)
  
  await page.focus(selector)
  await page.waitForTimeout(200)
  await page.click(selector, { clickCount: 3 })
  await page.waitForTimeout(100)
  await page.keyboard.press('Delete')
  await page.waitForTimeout(200)

  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    await page.keyboard.type(char, { delay: 75 })
    await page.waitForTimeout(100)

    if (i % 3 === 0) {
      const currentVal = await page.inputValue(selector)
      console.log(`      Progress: "${currentVal}"`)
    }
  }
  
  await page.waitForTimeout(1000)
  return true
}

// Smart value assignment based on field names/types
function getSmartDefaultValue(label, type) {
  const lowerLabel = label.toLowerCase()
  
  // Smart matching for different field types
  if (lowerLabel.includes('first') && lowerLabel.includes('name')) {
    return DEFAULT_VALUES.firstName
  }
  if (lowerLabel.includes('last') && lowerLabel.includes('name')) {
    return DEFAULT_VALUES.lastName
  }
  if (lowerLabel.includes('email')) {
    return DEFAULT_VALUES.email
  }
  if (lowerLabel.includes('password')) {
    if (lowerLabel.includes('confirm') || lowerLabel.includes('repeat')) {
      return DEFAULT_VALUES.confirmPassword
    }
    return DEFAULT_VALUES.password
  }
  if (lowerLabel.includes('otp') || lowerLabel.includes('code') || lowerLabel.includes('verification')) {
    return DEFAULT_VALUES.otp
  }
  if (lowerLabel.includes('phone') || lowerLabel.includes('mobile')) {
    return '+1234567890'
  }
  if (type === 'number') {
    return '123'
  }
  if (type === 'tel') {
    return '+1234567890'
  }
  
  return null
}

// ================================
// ENHANCED AUTOMATION TOOLS
// ================================

const navigateToPage = tool({
  name: 'navigate_to_page',
  description: 'Navigate to a specific auth page',
  parameters: z.object({
    pageName: z.enum(['signup', 'login', 'forgot-password', 'verify-otp', 'password-reset']),
    customValues: z.union([z.record(z.string(), z.string()), z.null()])
  }),
  async execute({ pageName, customValues }) {
    console.log(`\n🌐 Navigating to ${pageName} page...`)
    
    const values = customValues || {}
    
    try {
      const pageConfig = PAGE_DEFINITIONS[pageName]
      if (!pageConfig) {
        throw new Error(`Unknown page: ${pageName}`)
      }
      
      if (browser) {
        await browser.close()
        browser = null
        page = null
      }
      
      const currentPage = await getPage()
      await currentPage.goto(pageConfig.url, { waitUntil: 'networkidle' })
      
      console.log(`✅ Successfully navigated to ${pageConfig.name}`)
      console.log(`   URL: ${pageConfig.url}`)
      console.log(`   Fields to fill: ${pageConfig.fields.length}`)
      
      return {
        success: true,
        pageName,
        pageTitle: pageConfig.name,
        url: pageConfig.url,
        fieldCount: pageConfig.fields.length,
        fields: pageConfig.fields.map(f => ({ label: f.label, type: f.type }))
      }
    } catch (error) {
      console.log(`❌ Failed to navigate to ${pageName}: ${error.message}`)
      return { success: false, error: error.message, pageName }
    }
  }
})

const detectPageFields = tool({
  name: 'detect_page_fields',
  description: 'Dynamically detects all form fields on the current page',
  parameters: z.object({
    pageName: z.enum(['signup', 'login', 'forgot-password', 'verify-otp', 'password-reset'])
  }),
  async execute({ pageName }) {
    console.log(`\n🔍 Detecting fields on ${pageName} page...`)
    
    try {
      const currentPage = await getPage()
      const detectedFields = []
      
      // Common field selectors to check
      const fieldSelectors = [
        'input[type="text"]',
        'input[type="email"]', 
        'input[type="password"]',
        'input[type="tel"]',
        'input[type="number"]',
        'textarea'
      ]
      
      for (const selector of fieldSelectors) {
        const elements = await currentPage.locator(selector).all()
        
        for (const element of elements) {
          try {
            const id = await element.getAttribute('id')
            const name = await element.getAttribute('name')
            const placeholder = await element.getAttribute('placeholder')
            const type = await element.getAttribute('type')
            const isVisible = await element.isVisible()
            
            if (isVisible && (id || name)) {
              // Try to find associated label
              let label = ''
              if (id) {
                try {
                  const labelElement = await currentPage.locator(`label[for="${id}"]`).first()
                  label = await labelElement.textContent()
                } catch (e) {
                  // Try to find label by proximity
                  try {
                    const parentLabel = await element.locator('..').locator('label').first()
                    label = await parentLabel.textContent()
                  } catch (e2) {
                    label = placeholder || id || name || 'Unknown Field'
                  }
                }
              }
              
              detectedFields.push({
                label: label?.trim() || placeholder || id || name,
                selector: id ? `#${id}` : `[name="${name}"]`,
                type: type || 'text',
                id: id,
                name: name,
                placeholder: placeholder
              })
            }
          } catch (error) {
            console.log(`  ⚠️ Could not analyze element: ${error.message}`)
          }
        }
      }
      
      console.log(`✅ Detected ${detectedFields.length} fields:`)
      detectedFields.forEach((field, index) => {
        console.log(`  ${index + 1}. ${field.label} (${field.selector})`)
      })
      
      return {
        success: true,
        pageName,
        detectedFields,
        fieldCount: detectedFields.length
      }
      
    } catch (error) {
      console.log(`❌ Failed to detect fields on ${pageName}: ${error.message}`)
      return { success: false, error: error.message, pageName }
    }
  }
})

const smartProcessPageForm = tool({
  name: 'smart_process_page_form',
  description: 'Intelligently processes form using both predefined config and dynamic detection',
  parameters: z.object({
    pageName: z.enum(['signup', 'login', 'forgot-password', 'verify-otp', 'password-reset']),
    customValues: z.union([z.record(z.string(), z.string()), z.null()]),
    useDetection: z.union([z.boolean(), z.null()])
  }),
  async execute({ pageName, customValues, useDetection }) {
    console.log(`\n🧠 Smart processing ${pageName} form...`)
    
    const values = customValues || {}
    const shouldDetect = useDetection || false
    
    try {
      // Start with predefined configuration
      const pageConfig = PAGE_DEFINITIONS[pageName]
      let fieldsToProcess = [...pageConfig.fields]
      
      // Optionally detect additional fields
      if (shouldDetect) {
        console.log(`🔍 Running dynamic field detection...`)
        const currentPage = await getPage()
        
        // Detect fields dynamically
        const allInputs = await currentPage.locator('input, textarea').all()
        
        for (const input of allInputs) {
          try {
            const id = await input.getAttribute('id')
            const type = await input.getAttribute('type')
            const placeholder = await input.getAttribute('placeholder')
            const isVisible = await input.isVisible()
            
            if (isVisible && id && !fieldsToProcess.some(f => f.selector === `#${id}`)) {
              // Find label for this input
              let label = placeholder || id
              try {
                const labelElement = await currentPage.locator(`label[for="${id}"]`).first()
                const labelText = await labelElement.textContent()
                if (labelText) label = labelText.trim()
              } catch (e) {
                // Label not found, use placeholder or id
              }
              
              fieldsToProcess.push({
                label: label,
                selector: `#${id}`,
                type: type || 'text',
                required: false,
                detected: true
              })
              
              console.log(`  ➕ Detected additional field: ${label} (${id})`)
            }
          } catch (error) {
            // Skip problematic elements
          }
        }
      }
      
      console.log(`📋 Processing ${fieldsToProcess.length} fields total`)
      
      const currentPage = await getPage()
      const results = []
      
      // Process each field
      for (const fieldConfig of fieldsToProcess) {
        console.log(`\n--- Processing ${fieldConfig.label} field ${fieldConfig.detected ? '(detected)' : '(predefined)'} ---`)
        
        // Determine value to use with smart matching
        let valueToUse = 
          values[fieldConfig.label] || 
          values[fieldConfig.selector.replace('#', '')] ||
          values[fieldConfig.label.toLowerCase().replace(/\s+/g, '')] ||
          getSmartDefaultValue(fieldConfig.label, fieldConfig.type) ||
          'defaultValue123'
        
        console.log(`  Using value: "${valueToUse}"`)
        
        // Fill the field with retry logic
        let attempt = 0
        let success = false
        const maxRetries = 2
        
        while (attempt <= maxRetries && !success) {
          attempt++
          console.log(`  Attempt ${attempt}/${maxRetries + 1}`)
          
          try {
            await fillFieldSlowly(currentPage, fieldConfig.selector, valueToUse)
            
            // Verify immediately
            await currentPage.waitForTimeout(1000)
            const actualValue = await currentPage.inputValue(fieldConfig.selector)
            
            if (actualValue === valueToUse) {
              console.log(`  ✅ ${fieldConfig.label}: "${actualValue}"`)
              success = true
            } else {
              console.log(`  ❌ ${fieldConfig.label}: Expected "${valueToUse}", got "${actualValue}"`)
              if (attempt <= maxRetries) {
                await currentPage.waitForTimeout(2000)
              }
            }
          } catch (error) {
            console.log(`  ❌ Error filling ${fieldConfig.label}: ${error.message}`)
          }
        }
        
        results.push({
          field: fieldConfig.label,
          selector: fieldConfig.selector,
          expectedValue: valueToUse,
          actualValue: await currentPage.inputValue(fieldConfig.selector),
          success,
          attempts: attempt,
          detected: fieldConfig.detected || false
        })
      }
      
      // Final verification
      const allSuccess = results.every(r => r.success)
      const predefinedCount = results.filter(r => !r.detected).length
      const detectedCount = results.filter(r => r.detected).length
      
      console.log(`\n📊 Smart Processing Summary:`)
      console.log(`   Predefined fields: ${results.filter(r => r.success && !r.detected).length}/${predefinedCount}`)
      console.log(`   Detected fields: ${results.filter(r => r.success && r.detected).length}/${detectedCount}`)
      console.log(`   Total success: ${results.filter(r => r.success).length}/${results.length}`)
      
      return {
        success: allSuccess,
        pageName,
        results,
        fieldsProcessed: results.length,
        successCount: results.filter(r => r.success).length,
        predefinedCount,
        detectedCount,
        readyForSubmit: allSuccess
      }
      
    } catch (error) {
      console.log(`❌ Failed to smart process ${pageName} form: ${error.message}`)
      return { success: false, error: error.message, pageName }
    }
  }
})

const processPageForm = tool({
  name: 'process_page_form',
  description: 'Process form using only predefined PAGE_DEFINITIONS',
  parameters: z.object({
    pageName: z.enum(['signup', 'login', 'forgot-password', 'verify-otp', 'password-reset']),
    customValues: z.union([z.record(z.string(), z.string()), z.null()]),
    skipSubmit: z.union([z.boolean(), z.null()])
  }),
  async execute({ pageName, customValues, skipSubmit }) {
    console.log(`\n📝 Processing ${pageName} form (predefined only)...`)
    
    const values = customValues || {}
    const shouldSkipSubmit = skipSubmit || false
    
    try {
      const pageConfig = PAGE_DEFINITIONS[pageName]
      if (!pageConfig) {
        throw new Error(`Unknown page: ${pageName}`)
      }
      
      const currentPage = await getPage()
      const results = []
      
      // Process each predefined field
      for (const fieldConfig of pageConfig.fields) {
        console.log(`\n--- Processing ${fieldConfig.label} field ---`)
        
        // Determine value to use
        let valueToUse = values[fieldConfig.label] || 
                        values[fieldConfig.selector.replace('#', '')] ||
                        DEFAULT_VALUES[fieldConfig.selector.replace('#', '')] ||
                        DEFAULT_VALUES[fieldConfig.label.toLowerCase().replace(' ', '')] ||
                        'defaultValue123'
        
        console.log(`  Using value: "${valueToUse}"`)
        
        // Fill the field
        let attempt = 0
        let success = false
        const maxRetries = 2
        
        while (attempt <= maxRetries && !success) {
          attempt++
          console.log(`  Attempt ${attempt}/${maxRetries + 1}`)
          
          try {
            await fillFieldSlowly(currentPage, fieldConfig.selector, valueToUse)
            
            // Verify immediately
            await currentPage.waitForTimeout(1000)
            const actualValue = await currentPage.inputValue(fieldConfig.selector)
            
            if (actualValue === valueToUse) {
              console.log(`  ✅ ${fieldConfig.label}: "${actualValue}"`)
              success = true
            } else {
              console.log(`  ❌ ${fieldConfig.label}: Expected "${valueToUse}", got "${actualValue}"`)
              if (attempt <= maxRetries) {
                await currentPage.waitForTimeout(2000)
              }
            }
          } catch (error) {
            console.log(`  ❌ Error filling ${fieldConfig.label}: ${error.message}`)
          }
        }
        
        results.push({
          field: fieldConfig.label,
          selector: fieldConfig.selector,
          expectedValue: valueToUse,
          actualValue: await currentPage.inputValue(fieldConfig.selector),
          success,
          attempts: attempt
        })
      }
      
      // Final verification
      const allSuccess = results.every(r => r.success)
      console.log(`\n📊 Form Processing Summary: ${results.filter(r => r.success).length}/${results.length} fields successful`)
      
      return {
        success: allSuccess,
        pageName,
        results,
        fieldsProcessed: results.length,
        successCount: results.filter(r => r.success).length,
        readyForSubmit: allSuccess && !shouldSkipSubmit
      }
      
    } catch (error) {
      console.log(`❌ Failed to process ${pageName} form: ${error.message}`)
      return { success: false, error: error.message, pageName }
    }
  }
})

const submitForm = tool({
  name: 'submit_form',
  description: 'Submit the current form if all validations pass',
  parameters: z.object({
    pageName: z.enum(['signup', 'login', 'forgot-password', 'verify-otp', 'password-reset'])
  }),
  async execute({ pageName }) {
    console.log(`\n🚀 Submitting ${pageName} form...`)
    
    try {
      const pageConfig = PAGE_DEFINITIONS[pageName]
      const currentPage = await getPage()
      
      // Wait for submit button to be ready
      await currentPage.waitForSelector(pageConfig.submitSelector, { timeout: 10000, state: 'visible' })
      await currentPage.waitForTimeout(1000)
      
      // Click submit
      await currentPage.click(pageConfig.submitSelector)
      
      console.log(`✅ Form submitted successfully`)
      
      // Wait a moment to see result
      await currentPage.waitForTimeout(3000)
      
      return {
        success: true,
        pageName,
        submitText: pageConfig.submitText,
        message: 'Form submitted successfully'
      }
      
    } catch (error) {
      console.log(`❌ Failed to submit ${pageName} form: ${error.message}`)
      return { success: false, error: error.message, pageName }
    }
  }
})

const takeScreenShot = tool({
  name: 'take_screenshot',
  description: 'Takes a screenshot and saves it locally',
  parameters: z.object({
    description: z.union([z.string(), z.null()])
  }),
  async execute({ description }) {
    const desc = description || ''
    console.log(`📸 Taking screenshot... ${desc}`)
    const currentPage = await getPage()
    screenshotCounter++

    const buffer = await currentPage.screenshot({ type: 'png', fullPage: true })
    const filename = `step-${screenshotCounter}-${desc.replace(/\s+/g, '-') || 'screenshot'}.png`
    fs.writeFileSync(filename, buffer)
    console.log(`📸 Screenshot saved: ${filename}`)

    return { 
      success: true,
      filename: filename,
      step: screenshotCounter,
      description: desc
    }
  }
})

// ================================
// ENHANCED AI AGENT
// ================================

const enhancedMultiPageAgent = new Agent({
  name: 'enhanced_multi_page_agent',
  model: 'gpt-4o',
  instructions: `
You are an enhanced multi-page automation agent with smart field detection capabilities.

CAPABILITIES:
- Use predefined PAGE_DEFINITIONS for known field structures
- Dynamically detect additional fields not in predefined config
- Smart value assignment based on field names and types
- Comprehensive field processing with retry logic

WORKFLOW OPTIONS:

OPTION 1 - Use Predefined Config Only:
1. Use navigate_to_page 
2. Use process_page_form with skipSubmit=null
3. Submit form

OPTION 2 - Use Smart Detection (RECOMMENDED):
1. Use navigate_to_page
2. Use smart_process_page_form with useDetection=true
3. This combines predefined + detected fields
4. Submit form

OPTION 3 - Detect Fields First:
1. Use navigate_to_page
2. Use detect_page_fields to see all available fields
3. Use smart_process_page_form based on detection results

SMART VALUE MATCHING:
- firstName, lastName, email, password automatically detected
- OTP, phone, verification codes handled intelligently
- Custom values override smart defaults
- Fallback to safe default values for unknown fields

The system is now hybrid - uses your predefined PAGE_DEFINITIONS but can discover and handle additional fields dynamically.
`,
  tools: [navigateToPage, processPageForm, smartProcessPageForm, detectPageFields, submitForm, takeScreenShot]
})

// ================================
// EXECUTION FUNCTIONS
// ================================

async function processSinglePage(pageName, customValues = {}) {
  try {
    console.log(`\n🎯 Processing ${pageName} page...`)
    
    const result = await run(
      enhancedMultiPageAgent,
      `Process the ${pageName} page with smart detection:
      
      1. Navigate to ${pageName} page (pass null for customValues)
      2. Take screenshot with description "initial-${pageName}-page"
      3. Use smart_process_page_form with useDetection=true to combine predefined + detected fields
      4. Take screenshot with description "filled-${pageName}-form"  
      5. Submit the form if all validations pass
      6. Take screenshot with description "submitted-${pageName}-form"

      Use default values: firstName="Dnyaneshwar", lastName="Dimble", email="dnyaneshwardimble25436@gmail.com", password="mySecret123", otp="123456"

      Expected field counts:
      - signup: 5 fields (firstName, lastName, email, password, confirmPassword)
      - login: 2 fields (email, password)
      - forgot-password: 1 field (email)
      - verify-otp: 1 field (otp)
      - password-reset: 2 fields (password, confirmPassword)`
    )
    
    console.log('\n✅ Single page processing completed:', result)
    return result
  } catch (error) {
    console.error('\n❌ Error processing single page:', error)
    throw error
  }
}

async function processMultiplePages() {
  const pagesToProcess = [
    { 
      name: 'signup', 
      values: {
        firstName: 'Dnyaneshwar',
        lastName: 'Dimble', 
        email: 'dnyaneshwardimble25436@gmail.com.com',
        password: 'signupPass123',
        confirmPassword: 'signupPass123'
      }
    },
    { 
      name: 'login', 
      values: { 
        email: 'dnyaneshwardimble25436@gmail.com',
        password: 'loginPass123' 
      } 
    },
    { 
      name: 'forgot-password', 
      values: { 
        email: 'dnyaneshwardimble25436@gmail.com' 
      } 
    },
    { 
      name: 'verify-otp', 
      values: { 
        otp: '987654' 
      } 
    },
    { 
      name: 'password-reset', 
      values: { 
        password: 'newPass123',
        confirmPassword: 'newPass123' 
      } 
    }
  ]
  
  console.log(`\n🔄 Processing ${pagesToProcess.length} pages in sequence...`)
  
  for (let i = 0; i < pagesToProcess.length; i++) {
    const pageConfig = pagesToProcess[i]
    
    console.log(`\n${'='.repeat(60)}`)
    console.log(`🎯 PROCESSING PAGE ${i + 1}/${pagesToProcess.length}: ${pageConfig.name.toUpperCase()}`)
    console.log(`${'='.repeat(60)}`)
    
    try {
      await processSinglePage(pageConfig.name, pageConfig.values)
      console.log(`✅ Successfully completed ${pageConfig.name}`)
      
      // Wait between pages (except for the last one)
      if (i < pagesToProcess.length - 1) {
        console.log('\n⏳ Waiting 3 seconds before next page...')
        await new Promise(resolve => setTimeout(resolve, 3000))
      }
    } catch (error) {
      console.error(`❌ Error processing ${pageConfig.name}:`, error.message)
      console.log('🔄 Continuing with next page...')
    }
  }
  
  console.log('\n🎉 All pages processing completed!')
}

// ================================
// MAIN EXECUTION
// ================================

async function main() {
  const mode = process.argv[2] || 'single';
  const pageName = process.argv[3] || 'signup';
  
  console.log('\n🚀 Starting Enhanced Dynamic Multi-Page Automation System')
  console.log(`Mode: ${mode}`)
  
  if (mode === 'single') {
    console.log(`Page: ${pageName}`)
  }
  
  try {
    if (mode === 'multi') {
      // Process all pages in sequence
      await processMultiplePages()
    } else {
      // Process single page
      await processSinglePage(pageName)
    }
  } catch (error) {
    console.error('\n💥 Fatal error:', error)
  } finally {
    if (browser) {
      await browser.close()
    }
    console.log('\n👋 Automation completed!')
  }
}

main().catch(console.error)


// For Multiple Page Processing
// node index.js multi = this will automate the entire multi-page process 


//For Single Page Processing
// node index.js single signup
// node index.js single login
// node index.js single forgot-password
// node index.js single verify-otp
// node index.js single password-reset

