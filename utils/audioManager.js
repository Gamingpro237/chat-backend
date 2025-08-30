import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class AudioManager {
  constructor(supabase) {
    this.supabase = supabase;
    
    // FIXED: Use absolute path from project root
    this.baseAudioDir = path.join(process.cwd(), 'audios');
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
      
      // Create default template files if they don't exist
      await this.createDefaultTemplates();
    } catch (error) {
      console.error('Error initializing directories:', error);
    }
  }

  async createDefaultTemplates() {
    try {
      const defaultTemplates = {
        'intro_0.json': JSON.stringify({
          mouthCues: [
            { start: 0, end: 0.5, value: 'X' },
            { start: 0.5, end: 1.0, value: 'A' }
          ]
        }),
        'intro_1.json': JSON.stringify({
          mouthCues: [
            { start: 0, end: 0.3, value: 'X' },
            { start: 0.3, end: 0.8, value: 'B' },
            { start: 0.8, end: 1.2, value: 'C' }
          ]
        }),
        'message_0.json': JSON.stringify({
          mouthCues: [
            { start: 0, end: 0.4, value: 'X' },
            { start: 0.4, end: 0.9, value: 'D' },
            { start: 0.9, end: 1.5, value: 'E' }
          ]
        })
      };

      for (const [filename, content] of Object.entries(defaultTemplates)) {
        const templatePath = path.join(this.templatesDir, filename);
        
        try {
          await fs.access(templatePath);
          console.log(`Template exists: ${filename}`);
        } catch {
          // Create the template file with default content
          await fs.writeFile(templatePath, content);
          console.log(`Created default template: ${filename}`);
        }
      }
    } catch (error) {
      console.error('Error creating default templates:', error);
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
      
      // Ensure user directory exists
      await fs.mkdir(userDir, { recursive: true });
      
      // Ensure templates directory exists and has files
      await this.createDefaultTemplates();
      
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
            await fs.writeFile(destPath, JSON.stringify({ mouthCues: [] }));
          }
        }
      }
    } catch (error) {
      console.error('Error copying template files:', error);
      // Don't throw error, just log it - we can continue without templates
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
            console.log(`Directory ${userDir} doesn't exist:`, dirError.message);
          }

          // Delete the session record
          const { error: deleteError } = await this.supabase
            .from('user_audio_sessions')
            .delete()
            .eq('session_id', session.session_id);

          if (deleteError) {
            console.error(`Error deleting session ${session.session_id}:`, deleteError);
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
