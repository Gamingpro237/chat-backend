import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class AudioManager {
  constructor(supabase) {
    this.supabase = supabase;
    
    // Correct path: go up two levels from utils/ to backend/ then to audios/
    this.baseAudioDir = path.join(__dirname, '..', 'audios');
    this.usersDir = path.join(this.baseAudioDir, 'users');
    this.templatesDir = path.join(this.baseAudioDir, 'templates');
    
    console.log('Audio directories configured:');
    console.log('Base:', this.baseAudioDir);
    console.log('Users:', this.usersDir);
    console.log('Templates:', this.templatesDir);
    
    // Ensure base directories exist
    this.initializeDirectories();
  }

  async initializeDirectories() {
    try {
      await fs.mkdir(this.baseAudioDir, { recursive: true });
      await fs.mkdir(this.usersDir, { recursive: true });
      await fs.mkdir(this.templatesDir, { recursive: true });
      
      console.log('Audio directories initialized successfully');
      
      // Copy initial template files if they don't exist
      await this.setupTemplateFiles();
    } catch (error) {
      console.error('Error initializing directories:', error);
    }
  }

  async setupTemplateFiles() {
    try {
      const templateFiles = [
        'intro_0.json',
        'intro_1.json',
        'message_0.json'
      ];

      for (const file of templateFiles) {
        const sourcePath = path.join(this.baseAudioDir, file);
        const templatePath = path.join(this.templatesDir, file);
        
        try {
          // Check if source file exists
          await fs.access(sourcePath);
          
          // Check if template doesn't exist, then copy
          try {
            await fs.access(templatePath);
            console.log(`Template exists: ${file}`);
          } catch {
            await fs.copyFile(sourcePath, templatePath);
            console.log(`Copied template: ${file}`);
          }
        } catch {
          // Source file doesn't exist, create empty template
          console.log(`Source not found: ${file}, creating empty template`);
          await fs.writeFile(templatePath, JSON.stringify({}));
        }
      }
    } catch (error) {
      console.error('Error setting up template files:', error);
    }
  }

  async createUserDirectory(userId) {
    const userDir = path.join(this.usersDir, userId);
    
    try {
      await fs.mkdir(userDir, { recursive: true });
      console.log(`Created user directory: ${userDir}`);
      
      // Copy template files to user directory
      await this.copyTemplateFilesToUser(userId);
      
      return userDir;
    } catch (error) {
      console.error(`Error creating user directory for ${userId}:`, error);
      throw error;
    }
  }

  async copyTemplateFilesToUser(userId) {
    try {
      const userDir = path.join(this.usersDir, userId);
      
      // Ensure templates directory exists
      await fs.mkdir(this.templatesDir, { recursive: true });
      
      const templateFiles = await fs.readdir(this.templatesDir);
      
      for (const file of templateFiles) {
        const sourcePath = path.join(this.templatesDir, file);
        const destPath = path.join(userDir, file);
        
        try {
          await fs.copyFile(sourcePath, destPath);
          console.log(`Copied ${file} to user ${userId}`);
        } catch (error) {
          console.warn(`Could not copy ${file}:`, error.message);
          // Create empty file as fallback
          if (file.endsWith('.json')) {
            await fs.writeFile(destPath, JSON.stringify({}));
          }
        }
      }
    } catch (error) {
      console.error('Error copying template files:', error);
    }
  }

  async ensureUserDirectory(userId) {
    const userDir = path.join(this.usersDir, userId);
    
    try {
      await fs.access(userDir);
      return userDir;
    } catch {
      return await this.createUserDirectory(userId);
    }
  }

  generateSessionId() {
    return `session_${Date.now()}_${uuidv4().substring(0, 8)}`;
  }

  getUserAudioPath(userId, sessionId, messageIndex, extension) {
    return path.join(this.usersDir, userId, `${sessionId}_message_${messageIndex}.${extension}`);
  }

  async createAudioSession(userId, text, sessionId = null) {
    try {
      if (!sessionId) {
        sessionId = this.generateSessionId();
      }

      // Ensure user directory exists
      await this.ensureUserDirectory(userId);

      // Create database record
      const { data, error } = await this.supabase
        .from('user_audio_sessions')
        .insert({
          user_id: userId,
          session_id: sessionId,
          original_text: text,
          status: 'processing'
        })
        .select()
        .single();

      if (error) throw error;

      return { sessionId, dbRecord: data };
    } catch (error) {
      console.error('Error creating audio session:', error);
      throw error;
    }
  }

  async updateAudioSession(sessionId, updates) {
    try {
      const { error } = await this.supabase
        .from('user_audio_sessions')
        .update(updates)
        .eq('session_id', sessionId);

      if (error) throw error;
    } catch (error) {
      console.error('Error updating audio session:', error);
      throw error;
    }
  }

async cleanupOldFiles() {
  try {
    const cutoffTime = new Date(Date.now() - 24 * 60 * 60 * 1000);

    // Use Supabase client instead of fetch
    const { data: oldSessions, error } = await this.supabase
      .from('user_audio_sessions')
      .select('*')
      .lt('created_at', cutoffTime.toISOString());

    if (error) {
      console.error('Supabase query error:', error);
      return;
    }

    for (const session of oldSessions || []) {
      try {
        const userDir = path.join(this.usersDir, session.user_id);
        
        // Check if directory exists before reading
        try {
          await fs.access(userDir);
          const files = await fs.readdir(userDir);
          
          for (const file of files) {
            if (file.startsWith(session.session_id)) {
              await fs.unlink(path.join(userDir, file));
              console.log(`Deleted file: ${file}`);
            }
          }
        } catch (dirError) {
          console.log(`Directory ${userDir} doesn't exist or inaccessible:`, dirError.message);
          continue;
        }

        // Delete the session record
        const { error: deleteError } = await this.supabase
          .from('user_audio_sessions')
          .delete()
          .eq('session_id', session.session_id);

        if (deleteError) {
          console.error(`Error deleting session ${session.session_id}:`, deleteError);
        } else {
          console.log(`Deleted session record: ${session.session_id}`);
        }

      } catch (fileError) {
        console.error(`Error cleaning session ${session.session_id}:`, fileError);
      }
    }

    console.log(`Cleaned up ${oldSessions?.length || 0} sessions`);
  } catch (error) {
    console.error('Cleanup error:', error);
  }
}


  async getFilePaths(userId, sessionId, messageIndex) {
    return {
      mp3: this.getUserAudioPath(userId, sessionId, messageIndex, 'mp3'),
      wav: this.getUserAudioPath(userId, sessionId, messageIndex, 'wav'),
      json: this.getUserAudioPath(userId, sessionId, messageIndex, 'json')
    };
  }
}
