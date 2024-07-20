import * as sdk from "matrix-js-sdk";
import * as fs from "fs/promises";
import { createReadStream, createWriteStream } from "fs";
import fetch from "node-fetch";
import OpenAI from "openai";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import debugLib from "debug";
import sqlite3 from "sqlite3";
import { open, Database } from "sqlite";
import dotenv from "dotenv";

// Load environment variables from .env file
dotenv.config();

// Setup debug loggers
const log = debugLib("app:log");
const errorLog = debugLib("app:error");

// Configuration object
const config = {
  openaiApiKey: process.env.OPENAI_API_KEY,
  matrixBaseUrl: process.env.MATRIX_BASE_URL,
  matrixUserId: process.env.MATRIX_USER_ID,
  matrixAccessToken: process.env.MATRIX_ACCESS_TOKEN,
  dbFilePath: process.env.DB_FILE_PATH || "./transcriptions.db",
  tempDir: process.env.TEMP_DIR || "./temp",
  transcriptionsDir: process.env.TRANSCRIPTIONS_DIR || "./transcriptions",
};

if (
  !config.openaiApiKey ||
  !config.matrixBaseUrl ||
  !config.matrixUserId ||
  !config.matrixAccessToken
) {
  console.error(config);
  throw new Error("Missing required configuration");
}

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: config.openaiApiKey,
});

// Initialize Matrix client
const client = sdk.createClient({
  baseUrl: config.matrixBaseUrl,
  userId: config.matrixUserId,
  accessToken: config.matrixAccessToken,
});

let db: Database;

const initDb = async () => {
  db = await open({
    filename: config.dbFilePath,
    driver: sqlite3.Database,
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS processed_events (
      eventId TEXT PRIMARY KEY,
      userDisplayName TEXT,
      transcription TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS room_settings (
      roomId TEXT PRIMARY KEY,
      transcriptionEnabled BOOLEAN DEFAULT 0
    );
  `);
};

const transcribeAudio = async (
  httpUrl: string,
  userDisplayName: string,
  eventId: string
) => {
  try {
    log(
      "Starting transcription for URL: %s, User: %s",
      httpUrl,
      userDisplayName
    );

    // Download the audio file using fetch with streaming
    const response = await fetch(httpUrl);
    if (!response.ok)
      throw new Error(`Failed to fetch audio file: ${response.statusText}`);

    const audioFilePath = path.join(config.tempDir, `${uuidv4()}.ogg`);
    await fs.mkdir(path.dirname(audioFilePath), { recursive: true });

    const fileStream = createWriteStream(audioFilePath);
    response.body.pipe(fileStream);

    await new Promise((resolve, reject) => {
      fileStream.on("finish", resolve);
      fileStream.on("error", reject);
    });

    log("Downloaded audio file to %s", audioFilePath);

    // Transcribe the audio file using OpenAI Whisper
    const transcription = await openai.audio.transcriptions.create({
      model: "whisper-1",
      file: createReadStream(audioFilePath),
    });

    log("Received transcription: %O", transcription);

    // Update the event with the enhanced transcription AND display name
    await db.run(
      `UPDATE processed_events SET userDisplayName = ?, transcription = ? WHERE eventId = ?`,
      userDisplayName,
      transcription.text,
      eventId
    );

    // Clean up temporary audio file
    await fs.unlink(audioFilePath);
    log("Deleted temporary audio file: %s", audioFilePath);

    return transcription.text;
  } catch (error) {
    errorLog("Error processing audio file: %O", error);
  }
};

client.on(sdk.RoomEvent.Timeline, async (event, room) => {
  if (event.getType() === sdk.EventType.RoomMessage) {
    log("Received message in room: %s", room?.roomId);
    log("Message content: %s", JSON.stringify(event.getContent(), null, 2));
  }

  if (
    event.getType() === "m.room.message" &&
    event.getContent().msgtype === sdk.MsgType.Text
  ) {
    const body = event.getContent().body;
    const roomId = room?.roomId;
    const eventId = event.getId();

    if (!roomId || !eventId) return;

    log("Received message in room: %s", roomId);
    log("Message content: %s", JSON.stringify(event.getContent(), null, 2));

    // Command to enable transcription
    if (body === "!enableTranscription") {
      log("Enabling transcription for room: %s", roomId);
      await db.run(
        `INSERT INTO room_settings (roomId, transcriptionEnabled) VALUES (?, 1)
         ON CONFLICT(roomId) DO UPDATE SET transcriptionEnabled = 1`,
        roomId
      );

      await client.sendEvent(roomId, sdk.EventType.Reaction, {
        "m.relates_to": {
          event_id: eventId,
          key: "✅",
          rel_type: sdk.RelationType.Annotation,
        },
      });
      log("Transcription enabled for room: %s", roomId);
      return;
    }

    // Command to disable transcription
    if (body === "!disableTranscription") {
      log("Disabling transcription for room: %s", roomId);
      await db.run(
        `INSERT INTO room_settings (roomId, transcriptionEnabled) VALUES (?, 0)
         ON CONFLICT(roomId) DO UPDATE SET transcriptionEnabled = 0`,
        roomId
      );

      await client.sendEvent(roomId, sdk.EventType.Reaction, {
        "m.relates_to": {
          event_id: eventId,
          key: "✅",
          rel_type: sdk.RelationType.Annotation,
        },
      });
      log("Transcription disabled for room: %s", roomId);
      return;
    }
  }

  if (
    event.getType() === "m.room.message" &&
    event.getContent().msgtype === sdk.MsgType.Audio
  ) {
    const roomId = room?.roomId;
    if (!roomId) return;

    const row = await db.get(
      `SELECT transcriptionEnabled FROM room_settings WHERE roomId = ?`,
      roomId
    );
    if (!row || !row.transcriptionEnabled) {
      log("Transcription is disabled for room: %s", roomId);
      return;
    }

    const eventId = event.getId();
    if (!eventId) return;

    const sender = event.getSender();
    const user = sender ? client.getUser(sender) : null;

    if (!user) return;

    log("Received audio message from user: %s", user.displayName);
    log("Audio message content: %O", event.getContent());

    const contentUrl = event.getContent().url;
    const httpUrl = client.mxcUrlToHttp(contentUrl);

    log("Converted content URL to HTTP URL: %s", httpUrl);

    if (!httpUrl || !user.displayName) return;

    const rowEvent = await db.get(
      `SELECT eventId FROM processed_events WHERE eventId = ?`,
      eventId
    );
    if (rowEvent) {
      log("Event %s has already been processed", eventId);

      return;
    }

    await db.run("INSERT INTO processed_events (eventId) VALUES (?)", eventId);

    const text = await transcribeAudio(httpUrl, user.displayName, eventId);

    if (text) {
      await client.sendMessage(roomId, {
        msgtype: sdk.MsgType.Text,
        body: `Transkrypcja:\n${text}`,
        format: "org.matrix.custom.html",
        formatted_body: `<strong>Transkrypcja</strong>:\n${text}`,
        "m.relates_to": {
          "m.in_reply_to": {
            event_id: eventId,
          },
        },
      });
    }
  }
});

initDb()
  .then(() => {
    client.startClient({ initialSyncLimit: 0 }).catch((error: Error) => {
      errorLog("Error starting client: %O", error);
    });
  })
  .catch((error: Error) => {
    errorLog("Error initializing database: %O", error);
  });
