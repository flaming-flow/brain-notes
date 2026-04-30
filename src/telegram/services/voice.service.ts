import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn } from 'node:child_process';
import OpenAI from 'openai';

@Injectable()
export class VoiceService {
  private readonly logger = new Logger(VoiceService.name);
  private readonly openai: OpenAI;
  private readonly whisperModel: string;

  constructor(private readonly config: ConfigService) {
    this.openai = new OpenAI({
      apiKey: this.config.getOrThrow<string>('ai.openai.apiKey'),
    });
    this.whisperModel = this.config.get<string>('transcription.model', 'whisper-1');
  }

  async transcribe(fileUrl: string): Promise<string> {
    this.logger.log('Downloading voice file...');
    const response = await fetch(fileUrl);
    const oggBuffer = Buffer.from(await response.arrayBuffer());

    this.logger.log(`Converting OGG to MP3 (${oggBuffer.length} bytes)...`);
    const mp3Buffer = await this.convertOggToMp3(oggBuffer);

    this.logger.log(`Sending to Whisper (${mp3Buffer.length} bytes)...`);
    const file = new File([new Uint8Array(mp3Buffer)], 'voice.mp3', { type: 'audio/mpeg' });
    const transcription = await this.openai.audio.transcriptions.create({
      file,
      model: this.whisperModel,
      language: 'ru',
    });

    this.logger.log(`Transcribed: "${transcription.text.slice(0, 80)}..."`);
    return transcription.text;
  }

  private convertOggToMp3(oggBuffer: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const ffmpeg = spawn('ffmpeg', [
        '-i', 'pipe:0',
        '-f', 'mp3',
        '-acodec', 'libmp3lame',
        '-ab', '64k',
        '-ar', '16000',
        '-ac', '1',
        'pipe:1',
      ]);

      const chunks: Buffer[] = [];
      ffmpeg.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
      ffmpeg.stderr.on('data', () => {}); // Suppress FFmpeg logs
      ffmpeg.on('close', (code) => {
        if (code === 0) resolve(Buffer.concat(chunks));
        else reject(new Error(`FFmpeg exited with code ${code}`));
      });
      ffmpeg.on('error', (err) => reject(new Error(`FFmpeg error: ${err.message}`)));
      ffmpeg.stdin.write(oggBuffer);
      ffmpeg.stdin.end();
    });
  }
}
