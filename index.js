import { exec } from "child_process";
import cors from "cors";
import dotenv from "dotenv";
import voice from "elevenlabs-node";
import express from "express";
import { promises as fs } from "fs";
import OpenAI from "openai";
import path from "path";
import { fileURLToPath } from "url";
import { createClient } from '@supabase/supabase-js';
import { AudioManager } from './utils/audioManager.js';

// Initialize environment variables
dotenv.config();

// Configure Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

const supabaseService = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Configure paths
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configure AI services
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const elevenLabsApiKey = process.env.ELEVEN_LABS_API_KEY;
const voiceID = process.env.VOICE_ID;

// Configure FFmpeg and rhubarb paths
const ffmpegPath = process.env.FFMPEG_PATH;
const rhubarbPath = process.env.RHUBARB_PATH;

// Initialize Audio Manager
const audioManager = new AudioManager(supabase);
await audioManager.initializeDirectories();

// Plan-specific transaction IDs (5 IDs per plan)
const PLAN_TRANSACTION_IDS = {
  pro: new Set([
    'fq82lw7rm04bzjn', 'yp63vd9gt58xsar', 'jm40cq1he79pwlo',
    'vx91bk4zn23dfmt', 'ur26ps5cw80ygxh'
  ]),
  pro_plus: new Set([
    'nb77tw0jl42vrea', 'ko54mf8ye31qzcd', 'ed09rh6sn75vxlp',
    'cz85jg2vm61tuqw', 'hs27nw4fx09kldb'
  ]),
  premium: new Set([
    'qa63vm1pr84jzox', 'ly48tf7bw52dshk', 'gx20rk5cq37vnlu',
    'pw39cl6jd81xzta', 'vb16sy0me49qhkn'
  ])
};

// Initialize Express app
const app = express();
app.use(express.json());
app.use(cors());
const port = process.env.PORT || 3000;

// Helper functions with error handling
const execCommand = (command) => {
  return new Promise((resolve, reject) => {
    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error(`Command failed: ${command}`);
        console.error(`Error: ${error.message}`);
        console.error(`Stderr: ${stderr}`);
        reject(error);
      } else {
        resolve(stdout);
      }
    });
  });
};

// just for optimizing audio
const optimizeAudioConversation = async (inputPath, outputPath) => {
  try{
    await execCommand(
      `"${ffmpegPath}" -y -i "${inputPath}" -acodec pcm_s16le -ar 16000 -ac 1 "${outputPath}"`
    );
    
    console.log(`Audio optimized and converted successfully`);
  } catch(error){
    console.log(`Optimized conversion failed, falling back to default`);
    // Run rhubarb lip-sync
    await execCommand(
      `"${ffmpegPath}" -y -i "${inputPath}" "${outputPath}"`
    );
  }  
};

const lipSyncMessage = async (userId, sessionId, messageIndex) => {
  try {
    const time = new Date().getTime();
    console.log(`Starting lip sync for user ${userId}, session ${sessionId}, message ${messageIndex}`);
    
    const filePaths = await audioManager.getFilePaths(userId, sessionId, messageIndex);
    
    // Convert MP3 to WAV
    await optimizeAudioConversation(filePaths.mp3, filePaths.wav);
    
    console.log(`Conversion done in ${new Date().getTime() - time}ms`);
    
    // Run rhubarb lip-sync
    await execCommand(
      `"${rhubarbPath}" -f json -o "${filePaths.json}" "${filePaths.wav}" -r phonetic`
    );
    
    console.log(`Lip sync done in ${new Date().getTime() - time}ms`);
    return filePaths.json;
  } catch (error) {
    console.error(`Lip sync failed for user ${userId}, session ${sessionId}, message ${messageIndex}:`, error);
    throw new Error('Lip sync processing failed');
  }
};

// Check user's message limit
const checkMessageLimit = async (userId) => {
  try {
    console.log(`Checking message limit for user: ${userId}`);
    
    // Get user's plan
    const { data: plan, error } = await supabase
      .from('user_plans')
      .select('*')
      .eq('user_id', userId)
      .single();

    console.log('User plan data:', plan);

    // If no plan exists, create free plan
    if (!plan) {
      console.log('No plan found, creating free plan');
      const { data: newPlan, error: insertError } = await supabase
        .from('user_plans')
        .insert({
          user_id: userId,
          plan_type: 'free',
          messages_remaining: 1,
          last_reset_date: new Date()
        })
        .select()
        .single();
      
      if (insertError) {
        console.error('Error creating plan:', insertError);
        throw insertError;
      }
      
      console.log('Created new plan:', newPlan);
      return { canSend: true, remaining: 1 };
    }

    // Reset daily messages if it's a new day
    const now = new Date();
    const lastReset = new Date(plan.last_reset_date);
    
    console.log('Checking date reset:', {
      now: now.toDateString(),
      lastReset: lastReset.toDateString(),
      needsReset: now.toDateString() !== lastReset.toDateString()
    });
    
    if (now.toDateString() !== lastReset.toDateString()) {
      const messagesAllocation = {
        'free': 1,
        'pro': 6,
        'pro_plus': 20,
        'premium': 50
      }[plan.plan_type] || 1;

      console.log(`Resetting messages for ${plan.plan_type} plan to ${messagesAllocation}`);

      const { data: updatedPlan, error: updateError } = await supabase
        .from('user_plans')
        .update({
          messages_remaining: messagesAllocation,
          last_reset_date: now
        })
        .eq('user_id', userId)
        .select()
        .single();

      if (updateError) {
        console.error('Error updating plan:', updateError);
        throw updateError;
      }
      
      console.log('Updated plan:', updatedPlan);
      return { canSend: true, remaining: messagesAllocation };
    }

    console.log(`Current plan status:`, {
      planType: plan.plan_type,
      remaining: plan.messages_remaining,
      canSend: plan.messages_remaining > 0
    });

    return { 
      canSend: plan.messages_remaining > 0,
      remaining: plan.messages_remaining
    };
  } catch (error) {
    console.error('Error checking message limit:', error);
    return { canSend: false, remaining: 0, error: error.message };
  }
};

// Decrement message count
const decrementMessageCount = async (userId) => {
  try {
    console.log(`Decrementing message count for user: ${userId}`);
    
    const { data, error } = await supabase
      .from('user_plans')
      .select('messages_remaining')
      .eq('user_id', userId)
      .single();

    if (error) throw error;

    if (data.messages_remaining > 0) {
      const { data: updated, error: updateError } = await supabase
        .from('user_plans')
        .update({ 
          messages_remaining: data.messages_remaining - 1 
        })
        .eq('user_id', userId)
        .select()
        .single();

      if (updateError) throw updateError;
      
      console.log(`Decremented messages. New count: ${updated.messages_remaining}`);
      return updated.messages_remaining;
    }
    
    return data.messages_remaining;
  } catch (error) {
    console.error('Error decrementing message count:', error);
    throw error;
  }
};

// Verify payment transaction
const verifyPayment = async (userId, transactionId, planType) => {
  try {
    // Validate that the transaction ID belongs to the selected plan
    const cleanTransactionId = transactionId.toLowerCase().trim();
    
    if (!PLAN_TRANSACTION_IDS[planType] || !PLAN_TRANSACTION_IDS[planType].has(cleanTransactionId)) {
      return { 
        success: false, 
        error: `Invalid transaction ID for ${planType} plan. Please use a valid ${planType} payment ID.` 
      };
    }

    // Check if transaction ID was already used (using service role)
    const { data: existingPayment, error: checkError } = await supabaseService
      .from('payments')
      .select('*')
      .eq('transaction_id', cleanTransactionId)
      .maybeSingle();

    if (checkError) throw checkError;

    if (existingPayment) {
      return { 
        success: false, 
        error: 'This payment ID has already been used. Please use a different payment ID from the available list.' 
      };
    }

    // Check user's current plan for information only (not to block)
    const { data: currentPlan, error: planError } = await supabaseService
      .from('user_plans')
      .select('plan_type')
      .eq('user_id', userId)
      .maybeSingle();

    if (planError && planError.code !== 'PGRST116') throw planError;

    // Allow upgrade/downgrade at any time - just log it
    if (currentPlan) {
      console.log(`User ${userId} changing plan from ${currentPlan.plan_type} to ${planType}`);
    }

    // Get payment amount based on plan type
    const planAmounts = {
      'pro': 2500,
      'pro_plus': 5000,
      'premium': 15000
    };

    // Record payment using service role
    const { error: paymentError } = await supabaseService
      .from('payments')
      .insert({
        user_id: userId,
        plan_type: planType,
        transaction_id: cleanTransactionId,
        used_at: new Date(),
        amount: planAmounts[planType] || 0
      });

    if (paymentError) throw paymentError;

    // Update user plan immediately using service role
    const messagesAllocation = {
      'free': 1,
      'pro': 6,
      'pro_plus': 20,
      'premium': 50
    }[planType];

    // Set expiration date to 30 days from now for paid plans
    const expiresAt = planType !== 'free' ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) : null;

    const { error: planUpdateError } = await supabaseService
      .from('user_plans')
      .upsert({
        user_id: userId,
        plan_type: planType,
        messages_remaining: messagesAllocation,
        last_reset_date: new Date(),
        updated_at: new Date(),
        expires_at: expiresAt
      });

    if (planUpdateError) throw planUpdateError;

    return { 
      success: true,
      message: `Payment verified successfully! Your ${planType} plan is now active.`
    };
  } catch (error) {
    console.error('Payment verification error:', error);
    return { success: false, error: 'Payment processing failed. Please try again.' };
  }
};

// Monthly cleanup function
const expireOldPlans = async () => {
  try {
    const now = new Date();
    console.log('Running plan expiration check at:', now.toISOString());
    
    // Find expired plans (using service role to ensure we can update)
    const { data: expiredPlans, error: findError } = await supabaseService
      .from('user_plans')
      .select('*')
      .lt('expires_at', now)
      .neq('plan_type', 'free');

    if (findError) {
      console.error('Error finding expired plans:', findError);
      return;
    }

    console.log(`Found ${expiredPlans?.length || 0} expired plans`);

    for (const plan of expiredPlans || []) {
      try {
        // Update the plan to free
        const { error: updateError } = await supabaseService
          .from('user_plans')
          .update({ 
            plan_type: 'free',
            messages_remaining: 1,
            expires_at: null,
            last_reset_date: now, // Reset the date to allow immediate free message
            updated_at: now
          })
          .eq('user_id', plan.user_id);

        if (updateError) {
          console.error(`Error updating expired plan for user ${plan.user_id}:`, updateError);
          continue;
        }

        // Update the payment status
        const { error: paymentError } = await supabaseService
          .from('payments')
          .update({ status: 'expired' })
          .eq('user_id', plan.user_id)
          .is('status', null);

        if (paymentError) {
          console.error(`Error updating payment status for user ${plan.user_id}:`, paymentError);
        }

        console.log(`Successfully expired plan for user ${plan.user_id}: ${plan.plan_type} -> free`);
      } catch (error) {
        console.error(`Error processing expired plan for user ${plan.user_id}:`, error);
      }
    }
    
    console.log('Plan expiration check completed');
  } catch (error) {
    console.error('Plan expiration check failed:', error);
  }
};

// Run cleanup daily at midnight
setInterval(expireOldPlans, 24 * 60 * 60 * 1000);

// Routes
app.post("/chat", async (req, res) => {
  let sessionId = null;
  
  try {
    const { message, userId } = req.body;
    
    const userPath = path.join(audioManager.baseAudioDir, userId);
    try{

      await fs.access(userPath);
    } catch {

      await audioManager.copyTemplateFilesToUser(userId);
    }
    console.log(`Received chat request from user: ${userId}, message: "${message}"`);
    
    if (!userId) {
      return res.status(400).json({ error: "User ID is required" });
    }
    
    // Check message limit first
    const limitCheck = await checkMessageLimit(userId);
    console.log('Message limit check result:', limitCheck);
    
    if (!limitCheck.canSend) {
      console.log('Message limit reached, sending upgrade prompt');
      return res.status(429).json({ 
        error: "Message limit reached",
        upgradeRequired: true,
        remaining: limitCheck.remaining,
        plans: [
          { name: "Pro", price: 2500, messages: 6 },
          { name: "Pro Plus", price: 5000, messages: 20 },
          { name: "Premium", price: 15000, messages: 50 }
        ]
      });
    }

    // Handle empty message with default response
    if (!message || !message.trim()) {
      console.log('Empty message, sending default response');
      return res.json({
        messages: [
          {
            text: "Hey dear... How was your day?",
            facialExpression: "smile",
            animation: "Talk1",
          },
          {
            text: "I missed you so much... Please don't go for so long!",
            facialExpression: "sad",
            animation: "Crying",
          },
        ],
      });
    }

    // Validate API keys
    if (!elevenLabsApiKey || !openai.apiKey) {
      console.error('Missing API keys');
      return res.status(500).json({ 
        error: "API configuration error. Please contact support."
      });
    }

    console.log('Getting ChatGPT response...');
    
    // Get ChatGPT response
    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo-1106",
      max_tokens: 500,
      temperature: 0.6,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `
            You are chatovia an AI companion.
            You will always reply with a JSON array of messages. With a maximum of 3 messages.
            Each message has a text, facialExpression, and animation property.
            The different facial expressions are: smile, sad, angry, surprised, funnyFace, and default.
            The different animations are: Talk0, Talk1, Talk2, Talk3, Crying, Laughing, Breakdance, Hiphop, Twerk0, Twerk1, Idle1, Idle2, Idle3, Idle4, Terrified, and Angry. 
          `,
        },
        { role: "user", content: message.trim() }
      ],
    });

    console.log('ChatGPT response received');

    let messages = JSON.parse(completion.choices[0].message.content);
    if (messages.messages) messages = messages.messages;

    console.log(`Processing ${messages.length} messages`);

    // Create audio session
    const { sessionId: newSessionId } = await audioManager.createAudioSession(userId, message.trim());
    sessionId = newSessionId;

    // Process each message
    for (let i = 0; i < messages.length; i++) {
      try {
        console.log(`Processing message ${i}: "${messages[i].text}"`);
        
        const filePaths = await audioManager.getFilePaths(userId, sessionId, i);
        
        // Generate audio with ElevenLabs
        console.log(`Generating audio for message ${i}...`);
        await voice.textToSpeech(elevenLabsApiKey, voiceID, filePaths.mp3, messages[i].text);
        
        // Generate lip-sync
        console.log(`Generating lip-sync for message ${i}...`);
        await lipSyncMessage(userId, sessionId, i);
        
        // Read generated files
        messages[i].audio = await fs.readFile(filePaths.mp3, { encoding: 'base64' });
        messages[i].lipsync = JSON.parse(await fs.readFile(filePaths.json, 'utf8'));

        console.log(`Successfully processed message ${i}`);

        // Clean up temporary files but keep mp3 for potential replay
        try {
          await fs.unlink(filePaths.wav);
          await fs.unlink(filePaths.json);
        } catch (cleanupError) {
          console.warn(`Cleanup warning for message ${i}:`, cleanupError.message);
        }
      } catch (error) {
        console.error(`Error processing message ${i}:`, error);
        messages[i] = {
          ...messages[i],
          audio: null,
          lipsync: null,
          facialExpression: "sad",
          animation: "Terrified"
        };
      }
    }

    // Update session status
    await audioManager.updateAudioSession(sessionId, {
      status: 'completed',
      processed_at: new Date()
    });

    // Decrement message count AFTER successful processing
    console.log('Decrementing message count...');
    const newCount = await decrementMessageCount(userId);
    console.log(`New message count: ${newCount}`);

    console.log('Sending response with processed messages');
    res.json({ 
      messages,
      remainingMessages: newCount
    });

  } catch (error) {
    console.error("Error in /chat endpoint:", error);
    
    // Update session status if we have a sessionId
    if (sessionId) {
      try {
        await audioManager.updateAudioSession(sessionId, {
          status: 'failed',
          error_message: error.message
        });
      } catch (updateError) {
        console.error('Error updating session status:', updateError);
      }
    }
    
    res.status(500).json({ 
      error: "An error occurred while processing your request",
      details: error.message 
    });
  }
});

app.post("/verify-payment", async (req, res) => {
  try {
    const { userId, transactionId, planType } = req.body;
    
    if (!userId || !transactionId || !planType) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const { success, error } = await verifyPayment(userId, transactionId, planType);
    
    if (success) {
      return res.json({ success: true });
    } else {
      return res.status(400).json({ success: false, error });
    }
  } catch (error) {
    console.error("Payment verification error:", error);
    res.status(500).json({ error: "Payment verification failed" });
  }
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ status: "OK", timestamp: new Date().toISOString() });
});

// Cleanup old files every hour
setInterval(() => {
  audioManager.cleanupOldFiles();
}, 60 * 60 * 1000);

// Root route (homepage)
app.get("/", (req, res) => {
  res.send("🚀 Backend is running! Try POST /chat or GET /health");
});
// Start server
app.listen(port, () => {
  console.log(`AI Companion listening on port ${port}`);
  console.log('Environment check:', {
    hasOpenAI: !!process.env.OPENAI_API_KEY,
    hasElevenLabs: !!process.env.ELEVEN_LABS_API_KEY,
    hasSupabase: !!process.env.SUPABASE_URL,
    hasFFmpeg: !!process.env.FFMPEG_PATH,
    hasRhubarb: !!process.env.RHUBARB_PATH
  });
});
