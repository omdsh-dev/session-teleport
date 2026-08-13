import { EventEmitter } from "node:events";
import { asJsonValue, canonicalJson, secret, sha256 } from "./canonical.js";
import { TeleportError } from "./types.js";
class TeleportAuthority {
  constructor(database, options = {}) {
    this.database = database;
    this.now = options.now ?? Date.now;
    this.defaultHandoffTtlMs = options.defaultHandoffTtlMs ?? 5 * 6e4;
    this.maxHandoffTtlMs = options.maxHandoffTtlMs ?? 60 * 6e4;
  }
  database;
  changes = new EventEmitter();
  now;
  defaultHandoffTtlMs;
  maxHandoffTtlMs;
  async checkHealth() {
    await this.database.query("SELECT 1");
  }
  async createSession(request) {
    assertIdentifier(request.sessionId, "sessionId");
    assertIdentifier(request.deviceId, "deviceId");
    const header = canonicalJson(request.header);
    const writerToken = secret();
    const inserted = await this.database.query(
      `INSERT INTO teleport_sessions
        (session_id, header, writer_epoch, writer_device_id, writer_token_hash)
       VALUES ($1, $2::jsonb, 1, $3, $4)
       ON CONFLICT (session_id) DO NOTHING
       RETURNING session_id`,
      [request.sessionId, header, request.deviceId, sha256(writerToken)]
    );
    if (inserted.rowCount !== 1) {
      throw new TeleportError("SESSION_EXISTS", `session "${request.sessionId}" already exists`);
    }
    const result = {
      sessionId: request.sessionId,
      revision: 0,
      nextSeq: 0,
      writer: { deviceId: request.deviceId, writerEpoch: 1, writerToken }
    };
    this.emit(request.sessionId, "created");
    return result;
  }
  async materializeSession(request) {
    const writer = {
      deviceId: request.deviceId,
      writerEpoch: 1,
      writerToken: request.writerToken
    };
    validateAppend({
      sessionId: request.sessionId,
      writer,
      expectedRevision: 0,
      expectedNextSeq: 0,
      idempotencyKey: request.idempotencyKey,
      events: request.events
    });
    const header = canonicalJson(request.header);
    const digest = sha256(
      canonicalJson({
        sessionId: request.sessionId,
        header: request.header,
        deviceId: request.deviceId,
        events: request.events
      })
    );
    const result = await this.database.transaction(async (transaction) => {
      const inserted = await transaction.query(
        `INSERT INTO teleport_sessions
          (session_id, header, writer_epoch, writer_device_id, writer_token_hash)
         VALUES ($1, $2::jsonb, 1, $3, $4)
         ON CONFLICT (session_id) DO NOTHING
         RETURNING session_id`,
        [request.sessionId, header, request.deviceId, sha256(request.writerToken)]
      );
      if (inserted.rowCount !== 1) {
        const session = await lockSession(transaction, request.sessionId);
        const previous = await transaction.query(
          `SELECT request_digest, committed_revision, committed_next_seq
             FROM teleport_mutations
            WHERE session_id = $1 AND idempotency_key = $2`,
          [request.sessionId, request.idempotencyKey]
        );
        const mutation = previous.rows[0];
        if (mutation !== void 0 && mutation.request_digest === digest) {
          assertWriter(session, writer);
          return {
            sessionId: request.sessionId,
            revision: integer(mutation.committed_revision, "committed_revision"),
            nextSeq: integer(mutation.committed_next_seq, "committed_next_seq"),
            writer,
            idempotentReplay: true
          };
        }
        throw new TeleportError(
          "SESSION_EXISTS",
          `session "${request.sessionId}" already exists`
        );
      }
      for (const event of request.events) {
        await transaction.query(
          `INSERT INTO teleport_events (session_id, seq, event)
           VALUES ($1, $2, $3::json)`,
          [request.sessionId, event.seq, eventJson(event)]
        );
      }
      const nextSeq = request.events.at(-1).seq + 1;
      await transaction.query(
        `UPDATE teleport_sessions
            SET revision = 1, next_seq = $2, updated_at = CURRENT_TIMESTAMP
          WHERE session_id = $1`,
        [request.sessionId, nextSeq]
      );
      await transaction.query(
        `INSERT INTO teleport_mutations
          (session_id, idempotency_key, request_digest, start_seq, end_seq,
           committed_revision, committed_next_seq)
         VALUES ($1, $2, $3, 0, $4, 1, $5)`,
        [
          request.sessionId,
          request.idempotencyKey,
          digest,
          request.events.at(-1).seq,
          nextSeq
        ]
      );
      return {
        sessionId: request.sessionId,
        revision: 1,
        nextSeq,
        writer,
        idempotentReplay: false
      };
    });
    if (!result.idempotentReplay) this.emit(request.sessionId, "created");
    return result;
  }
  async append(request) {
    validateAppend(request);
    const digest = sha256(
      canonicalJson({
        sessionId: request.sessionId,
        expectedRevision: request.expectedRevision,
        expectedNextSeq: request.expectedNextSeq,
        events: request.events
      })
    );
    const result = await this.database.transaction(async (transaction) => {
      const session = await lockSession(transaction, request.sessionId);
      const previous = await transaction.query(
        `SELECT request_digest, committed_revision, committed_next_seq
           FROM teleport_mutations
          WHERE session_id = $1 AND idempotency_key = $2`,
        [request.sessionId, request.idempotencyKey]
      );
      const mutation = previous.rows[0];
      if (mutation !== void 0) {
        if (mutation.request_digest !== digest) {
          throw new TeleportError(
            "IDEMPOTENCY_CONFLICT",
            `idempotency key "${request.idempotencyKey}" was already used for different content`
          );
        }
        return {
          revision: integer(mutation.committed_revision, "committed_revision"),
          nextSeq: integer(mutation.committed_next_seq, "committed_next_seq"),
          idempotentReplay: true
        };
      }
      assertWriter(session, request.writer);
      const revision = integer(session.revision, "revision");
      const nextSeq = integer(session.next_seq, "next_seq");
      if (revision !== request.expectedRevision) {
        throw new TeleportError(
          "REVISION_CONFLICT",
          `revision conflict: expected ${request.expectedRevision}, current ${revision}`
        );
      }
      if (nextSeq !== request.expectedNextSeq) {
        throw new TeleportError(
          "SEQ_CONFLICT",
          `next seq conflict: expected ${request.expectedNextSeq}, current ${nextSeq}`
        );
      }
      for (const event of request.events) {
        await transaction.query(
          `INSERT INTO teleport_events (session_id, seq, event)
           VALUES ($1, $2, $3::json)`,
          [request.sessionId, event.seq, eventJson(event)]
        );
      }
      const committedRevision = revision + 1;
      const committedNextSeq = request.events.at(-1).seq + 1;
      await transaction.query(
        `UPDATE teleport_sessions
            SET revision = $2, next_seq = $3, updated_at = CURRENT_TIMESTAMP
          WHERE session_id = $1`,
        [request.sessionId, committedRevision, committedNextSeq]
      );
      await transaction.query(
        `INSERT INTO teleport_mutations
          (session_id, idempotency_key, request_digest, start_seq, end_seq,
           committed_revision, committed_next_seq)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          request.sessionId,
          request.idempotencyKey,
          digest,
          request.events[0].seq,
          request.events.at(-1).seq,
          committedRevision,
          committedNextSeq
        ]
      );
      return { revision: committedRevision, nextSeq: committedNextSeq, idempotentReplay: false };
    });
    if (!result.idempotentReplay) this.emit(request.sessionId, "events");
    return result;
  }
  async snapshot(sessionId, afterSeq = -1) {
    assertIdentifier(sessionId, "sessionId");
    if (!Number.isSafeInteger(afterSeq) || afterSeq < -1) {
      throw new TeleportError("BAD_REQUEST", "afterSeq must be a safe integer >= -1");
    }
    return this.database.transaction(
      async (transaction) => {
        const sessionResult = await transaction.query(
          `SELECT session_id, header, revision, next_seq, writer_epoch,
                  writer_device_id, writer_token_hash
             FROM teleport_sessions WHERE session_id = $1`,
          [sessionId]
        );
        const session = sessionResult.rows[0];
        if (session === void 0) {
          throw new TeleportError("NOT_FOUND", `session "${sessionId}" not found`);
        }
        const eventResult = await transaction.query(
          `SELECT event::text AS event_text FROM teleport_events
            WHERE session_id = $1 AND seq > $2
            ORDER BY seq`,
          [sessionId, afterSeq]
        );
        return {
          sessionId,
          header: asJsonValue(session.header),
          revision: integer(session.revision, "revision"),
          nextSeq: integer(session.next_seq, "next_seq"),
          writerEpoch: integer(session.writer_epoch, "writer_epoch"),
          ...session.writer_device_id === null ? {} : { writerDeviceId: session.writer_device_id },
          events: eventResult.rows.map((row) => JSON.parse(row.event_text))
        };
      },
      { isolationLevel: "repeatable read", readOnly: true }
    );
  }
  async head(sessionId) {
    assertIdentifier(sessionId, "sessionId");
    const result = await this.database.query(
      `SELECT session_id, header, revision, next_seq, writer_epoch,
              writer_device_id, writer_token_hash
         FROM teleport_sessions WHERE session_id = $1`,
      [sessionId]
    );
    const session = result.rows[0];
    if (session === void 0) {
      throw new TeleportError("NOT_FOUND", `session "${sessionId}" not found`);
    }
    return headFromRow(session);
  }
  async listHeads() {
    const result = await this.database.query(
      `SELECT session_id, header, revision, next_seq, writer_epoch,
              writer_device_id, writer_token_hash
         FROM teleport_sessions
        ORDER BY created_at, session_id`
    );
    return result.rows.map(headFromRow);
  }
  async createHandoff(request) {
    assertIdentifier(request.sessionId, "sessionId");
    assertWriterCredentials(request.writer);
    const ttlMs = request.ttlMs ?? this.defaultHandoffTtlMs;
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > this.maxHandoffTtlMs) {
      throw new TeleportError(
        "BAD_REQUEST",
        `ttlMs must be a positive safe integer <= ${this.maxHandoffTtlMs}`
      );
    }
    const code = secret(18);
    const expiresAt = new Date(this.now() + ttlMs).toISOString();
    await this.database.transaction(async (transaction) => {
      const session = await lockSession(transaction, request.sessionId);
      assertWriter(session, request.writer);
      await transaction.query(
        `INSERT INTO teleport_handoffs (code_hash, session_id, from_epoch, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [sha256(code), request.sessionId, request.writer.writerEpoch, expiresAt]
      );
    });
    return { code, expiresAt };
  }
  async acceptHandoff(request) {
    assertIdentifier(request.code, "code");
    assertIdentifier(request.deviceId, "deviceId");
    const result = await this.database.transaction(async (transaction) => {
      const handoffResult = await transaction.query(
        `SELECT session_id, from_epoch, expires_at, consumed_at
           FROM teleport_handoffs
          WHERE code_hash = $1
          FOR UPDATE`,
        [sha256(request.code)]
      );
      const handoff = handoffResult.rows[0];
      if (handoff === void 0) {
        throw new TeleportError("NOT_FOUND", "handoff code not found");
      }
      if (handoff.consumed_at !== null) {
        throw new TeleportError("HANDOFF_CONSUMED", "handoff code was already consumed");
      }
      if (new Date(handoff.expires_at).getTime() <= this.now()) {
        throw new TeleportError("HANDOFF_EXPIRED", "handoff code has expired");
      }
      const session = await lockSession(transaction, handoff.session_id);
      const currentEpoch = integer(session.writer_epoch, "writer_epoch");
      const fromEpoch = integer(handoff.from_epoch, "from_epoch");
      if (currentEpoch !== fromEpoch) {
        throw new TeleportError(
          "WRITER_FENCED",
          `handoff was issued for writer epoch ${fromEpoch}, current epoch is ${currentEpoch}`
        );
      }
      const writerToken = secret();
      const writerTokenHash = sha256(writerToken);
      const writerEpoch = currentEpoch + 1;
      await transaction.query(
        `UPDATE teleport_sessions
            SET writer_epoch = $2, writer_device_id = $3,
                writer_token_hash = $4, updated_at = CURRENT_TIMESTAMP
          WHERE session_id = $1`,
        [handoff.session_id, writerEpoch, request.deviceId, writerTokenHash]
      );
      await transaction.query(
        `UPDATE teleport_handoffs SET consumed_at = CURRENT_TIMESTAMP WHERE code_hash = $1`,
        [sha256(request.code)]
      );
      const auditId = `handoff:${sha256(request.code)}`;
      await transaction.query(
        `INSERT INTO teleport_writer_audit
          (session_id, idempotency_key, request_digest, action, actor_id, reason,
           from_device_id, to_device_id, from_epoch, to_epoch,
           committed_revision, committed_next_seq)
         VALUES ($1, $2, $3, 'handoff', $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          handoff.session_id,
          auditId,
          sha256(
            canonicalJson({
              action: "handoff",
              sessionId: handoff.session_id,
              codeHash: sha256(request.code),
              deviceId: request.deviceId,
              fromEpoch,
              toEpoch: writerEpoch,
              writerTokenHash
            })
          ),
          request.deviceId,
          "one-time handoff accepted",
          session.writer_device_id,
          request.deviceId,
          fromEpoch,
          writerEpoch,
          integer(session.revision, "revision"),
          integer(session.next_seq, "next_seq")
        ]
      );
      return {
        sessionId: handoff.session_id,
        revision: integer(session.revision, "revision"),
        nextSeq: integer(session.next_seq, "next_seq"),
        writer: { deviceId: request.deviceId, writerEpoch, writerToken }
      };
    });
    this.emit(result.sessionId, "writer");
    return result;
  }
  async recoverWriter(request) {
    validateRecovery(request);
    const reason = request.reason.trim();
    const writerTokenHash = sha256(request.writerToken);
    const digest = sha256(
      canonicalJson({
        action: "admin_recovery",
        sessionId: request.sessionId,
        expectedRevision: request.expectedRevision,
        expectedWriterEpoch: request.expectedWriterEpoch,
        deviceId: request.deviceId,
        writerTokenHash,
        actorId: request.actorId,
        reason
      })
    );
    const writer = {
      deviceId: request.deviceId,
      writerEpoch: request.expectedWriterEpoch + 1,
      writerToken: request.writerToken
    };
    const result = await this.database.transaction(async (transaction) => {
      const session = await lockSession(transaction, request.sessionId);
      const previous = await transaction.query(
        `SELECT idempotency_key, request_digest, action, actor_id, reason,
                from_device_id, to_device_id, from_epoch, to_epoch,
                committed_revision, committed_next_seq, created_at
           FROM teleport_writer_audit
          WHERE session_id = $1 AND idempotency_key = $2`,
        [request.sessionId, request.idempotencyKey]
      );
      const audit = previous.rows[0];
      if (audit !== void 0) {
        if (audit.action !== "admin_recovery" || audit.request_digest !== digest) {
          throw new TeleportError(
            "IDEMPOTENCY_CONFLICT",
            `recovery idempotency key "${request.idempotencyKey}" was already used`
          );
        }
        const currentEpoch2 = integer(session.writer_epoch, "writer_epoch");
        const committedEpoch = integer(audit.to_epoch, "to_epoch");
        if (currentEpoch2 !== committedEpoch || session.writer_device_id !== request.deviceId || session.writer_token_hash !== writerTokenHash) {
          throw new TeleportError(
            "WRITER_FENCED",
            `recovered writer was superseded by epoch ${currentEpoch2}`
          );
        }
        return {
          sessionId: request.sessionId,
          revision: integer(session.revision, "revision"),
          nextSeq: integer(session.next_seq, "next_seq"),
          writer: { ...writer, writerEpoch: committedEpoch },
          idempotentReplay: true
        };
      }
      const currentRevision = integer(session.revision, "revision");
      const currentEpoch = integer(session.writer_epoch, "writer_epoch");
      if (currentRevision !== request.expectedRevision) {
        throw new TeleportError(
          "REVISION_CONFLICT",
          `revision conflict: expected ${request.expectedRevision}, current ${currentRevision}`
        );
      }
      if (currentEpoch !== request.expectedWriterEpoch) {
        throw new TeleportError(
          "WRITER_FENCED",
          `writer epoch conflict: expected ${request.expectedWriterEpoch}, current ${currentEpoch}`
        );
      }
      const writerEpoch = currentEpoch + 1;
      await transaction.query(
        `UPDATE teleport_sessions
            SET writer_epoch = $2, writer_device_id = $3,
                writer_token_hash = $4, updated_at = CURRENT_TIMESTAMP
          WHERE session_id = $1`,
        [request.sessionId, writerEpoch, request.deviceId, writerTokenHash]
      );
      await transaction.query(
        `INSERT INTO teleport_writer_audit
          (session_id, idempotency_key, request_digest, action, actor_id, reason,
           from_device_id, to_device_id, from_epoch, to_epoch,
           committed_revision, committed_next_seq)
         VALUES ($1, $2, $3, 'admin_recovery', $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          request.sessionId,
          request.idempotencyKey,
          digest,
          request.actorId,
          reason,
          session.writer_device_id,
          request.deviceId,
          currentEpoch,
          writerEpoch,
          currentRevision,
          integer(session.next_seq, "next_seq")
        ]
      );
      return {
        sessionId: request.sessionId,
        revision: currentRevision,
        nextSeq: integer(session.next_seq, "next_seq"),
        writer: { ...writer, writerEpoch },
        idempotentReplay: false
      };
    });
    if (!result.idempotentReplay) this.emit(request.sessionId, "writer");
    return result;
  }
  /**
   * Remove a freshly imported Session while the old backend is still the
   * rollback authority. Any append, handoff or recovery closes this window.
   */
  async rollbackImport(request) {
    validateImportRollback(request);
    const reason = request.reason.trim();
    const requestDigest = sha256(
      canonicalJson({
        action: "rollback_import",
        sessionId: request.sessionId,
        expectedRevision: request.expectedRevision,
        expectedNextSeq: request.expectedNextSeq,
        expectedWriterEpoch: request.expectedWriterEpoch,
        importIdempotencyKey: request.importIdempotencyKey,
        actorId: request.actorId,
        reason
      })
    );
    const result = await this.database.transaction(async (transaction) => {
      const previous = await transaction.query(
        `SELECT request_digest
           FROM teleport_import_rollback_audit
          WHERE session_id = $1 AND import_idempotency_key = $2`,
        [request.sessionId, request.importIdempotencyKey]
      );
      const audit = previous.rows[0];
      if (audit !== void 0) {
        if (audit.request_digest !== requestDigest) {
          throw new TeleportError(
            "IDEMPOTENCY_CONFLICT",
            "import rollback receipt was already used with different parameters"
          );
        }
        const reused = await transaction.query(
          `SELECT session_id FROM teleport_sessions WHERE session_id = $1`,
          [request.sessionId]
        );
        if (reused.rows.length !== 0) {
          throw new TeleportError(
            "IMPORT_NOT_ROLLBACKABLE",
            "session id was materialized again after the audited rollback"
          );
        }
        return {
          sessionId: request.sessionId,
          rolledBack: true,
          idempotentReplay: true
        };
      }
      let session;
      try {
        session = await lockSession(transaction, request.sessionId);
      } catch (error) {
        if (!(error instanceof TeleportError && error.code === "NOT_FOUND")) throw error;
        const concurrent = await transaction.query(
          `SELECT request_digest
             FROM teleport_import_rollback_audit
            WHERE session_id = $1 AND import_idempotency_key = $2`,
          [request.sessionId, request.importIdempotencyKey]
        );
        const committed = concurrent.rows[0];
        if (committed === void 0) throw error;
        if (committed.request_digest !== requestDigest) {
          throw new TeleportError(
            "IDEMPOTENCY_CONFLICT",
            "import rollback receipt was already used with different parameters"
          );
        }
        return {
          sessionId: request.sessionId,
          rolledBack: true,
          idempotentReplay: true
        };
      }
      const revision = integer(session.revision, "revision");
      const nextSeq = integer(session.next_seq, "next_seq");
      const writerEpoch = integer(session.writer_epoch, "writer_epoch");
      if (revision !== request.expectedRevision || nextSeq !== request.expectedNextSeq) {
        throw new TeleportError(
          "IMPORT_NOT_ROLLBACKABLE",
          `session advanced after import (revision ${revision}, next seq ${nextSeq})`
        );
      }
      if (writerEpoch !== request.expectedWriterEpoch || writerEpoch !== 1) {
        throw new TeleportError(
          "IMPORT_NOT_ROLLBACKABLE",
          `session writer changed after import (current epoch ${writerEpoch})`
        );
      }
      const mutations = await transaction.query(
        `SELECT idempotency_key, request_digest, start_seq, end_seq,
                committed_revision, committed_next_seq
           FROM teleport_mutations
          WHERE session_id = $1
          ORDER BY created_at, idempotency_key`,
        [request.sessionId]
      );
      const mutation = mutations.rows[0];
      const expectedEndSeq = request.expectedNextSeq - 1;
      if (mutations.rows.length !== 1 || mutation === void 0 || !request.importIdempotencyKey.startsWith("dsh-import-") || mutation.idempotency_key !== request.importIdempotencyKey || mutation.start_seq === void 0 || integer(mutation.start_seq, "start_seq") !== 0 || integer(mutation.end_seq, "end_seq") !== expectedEndSeq || integer(mutation.committed_revision, "committed_revision") !== request.expectedRevision || integer(mutation.committed_next_seq, "committed_next_seq") !== request.expectedNextSeq) {
        throw new TeleportError(
          "IMPORT_NOT_ROLLBACKABLE",
          "session is not an unchanged one-batch import"
        );
      }
      await transaction.query(
        `INSERT INTO teleport_import_rollback_audit
          (session_id, import_idempotency_key, request_digest, actor_id, reason,
           rolled_back_revision, rolled_back_next_seq, rolled_back_writer_epoch)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          request.sessionId,
          request.importIdempotencyKey,
          requestDigest,
          request.actorId,
          reason,
          revision,
          nextSeq,
          writerEpoch
        ]
      );
      await transaction.query(`DELETE FROM teleport_sessions WHERE session_id = $1`, [
        request.sessionId
      ]);
      return {
        sessionId: request.sessionId,
        rolledBack: true,
        idempotentReplay: false
      };
    });
    this.emit(request.sessionId, "writer");
    return result;
  }
  async listWriterAudit(sessionId, limit = 100) {
    assertIdentifier(sessionId, "sessionId");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new TeleportError("BAD_REQUEST", "audit limit must be an integer between 1 and 500");
    }
    await this.head(sessionId);
    const result = await this.database.query(
      `SELECT idempotency_key, request_digest, action, actor_id, reason,
              from_device_id, to_device_id, from_epoch, to_epoch,
              committed_revision, committed_next_seq, created_at
         FROM teleport_writer_audit
        WHERE session_id = $1
        ORDER BY created_at DESC, idempotency_key DESC
        LIMIT $2`,
      [sessionId, limit]
    );
    return result.rows.map((row) => ({
      idempotencyKey: row.idempotency_key,
      action: row.action,
      actorId: row.actor_id,
      reason: row.reason,
      ...row.from_device_id === null ? {} : { fromDeviceId: row.from_device_id },
      toDeviceId: row.to_device_id,
      fromEpoch: integer(row.from_epoch, "from_epoch"),
      toEpoch: integer(row.to_epoch, "to_epoch"),
      revision: integer(row.committed_revision, "committed_revision"),
      nextSeq: integer(row.committed_next_seq, "committed_next_seq"),
      createdAt: timestamp(row.created_at)
    }));
  }
  subscribe(sessionId, listener) {
    const eventName = `session:${sessionId}`;
    this.changes.on(eventName, listener);
    return () => this.changes.off(eventName, listener);
  }
  emit(sessionId, kind) {
    this.changes.emit(`session:${sessionId}`, kind);
  }
}
async function lockSession(transaction, sessionId) {
  const result = await transaction.query(
    `SELECT session_id, header, revision, next_seq, writer_epoch,
            writer_device_id, writer_token_hash
       FROM teleport_sessions
      WHERE session_id = $1
      FOR UPDATE`,
    [sessionId]
  );
  const session = result.rows[0];
  if (session === void 0) {
    throw new TeleportError("NOT_FOUND", `session "${sessionId}" not found`);
  }
  return session;
}
function assertWriter(session, writer) {
  const currentEpoch = integer(session.writer_epoch, "writer_epoch");
  const valid = session.writer_device_id === writer.deviceId && currentEpoch === writer.writerEpoch && session.writer_token_hash !== null && session.writer_token_hash === sha256(writer.writerToken);
  if (!valid) {
    throw new TeleportError(
      "WRITER_FENCED",
      `writer credentials are stale or invalid (current epoch ${currentEpoch})`
    );
  }
}
function headFromRow(session) {
  return {
    sessionId: session.session_id,
    header: asJsonValue(session.header),
    revision: integer(session.revision, "revision"),
    nextSeq: integer(session.next_seq, "next_seq"),
    writerEpoch: integer(session.writer_epoch, "writer_epoch"),
    ...session.writer_device_id === null ? {} : { writerDeviceId: session.writer_device_id }
  };
}
function validateAppend(request) {
  assertIdentifier(request.sessionId, "sessionId");
  assertWriterCredentials(request.writer);
  assertIdentifier(request.writer.deviceId, "writer.deviceId");
  assertIdentifier(request.writer.writerToken, "writer.writerToken");
  assertIdentifier(request.idempotencyKey, "idempotencyKey");
  safeNonNegative(request.writer.writerEpoch, "writer.writerEpoch");
  safeNonNegative(request.expectedRevision, "expectedRevision");
  safeNonNegative(request.expectedNextSeq, "expectedNextSeq");
  if (!Array.isArray(request.events) || request.events.length === 0) {
    throw new TeleportError("BAD_REQUEST", "append requires at least one event");
  }
  for (const [index, value] of request.events.entries()) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new TeleportError("BAD_REQUEST", `events[${index}] must be an object`);
    }
    const event = value;
    assertIdentifier(event.type, `events[${index}].type`);
    const seq = event.seq;
    const time = event.time;
    safeNonNegative(seq, `events[${index}].seq`);
    safeNonNegative(time, `events[${index}].time`);
    if (!("data" in event)) {
      throw new TeleportError("BAD_REQUEST", `events[${index}].data is required`);
    }
    if (event.sourceEventSeqs !== void 0) {
      if (!Array.isArray(event.sourceEventSeqs)) {
        throw new TeleportError(
          "BAD_REQUEST",
          `events[${index}].sourceEventSeqs must be an array`
        );
      }
      for (const [sourceIndex, sourceSeq] of event.sourceEventSeqs.entries()) {
        safeNonNegative(
          sourceSeq,
          `events[${index}].sourceEventSeqs[${sourceIndex}]`
        );
      }
    }
    const expected = request.expectedNextSeq + index;
    if (seq !== expected) {
      throw new TeleportError(
        "BAD_REQUEST",
        `events must be contiguous: expected seq ${expected}, got ${seq}`
      );
    }
  }
  canonicalJson(request.events);
}
function validateRecovery(request) {
  assertIdentifier(request.sessionId, "sessionId");
  assertIdentifier(request.deviceId, "deviceId");
  assertIdentifier(request.writerToken, "writerToken");
  assertIdentifier(request.idempotencyKey, "idempotencyKey");
  assertIdentifier(request.actorId, "actorId");
  safeNonNegative(request.expectedRevision, "expectedRevision");
  safePositive(request.expectedWriterEpoch, "expectedWriterEpoch");
  if (typeof request.reason !== "string" || request.reason.trim().length === 0) {
    throw new TeleportError("BAD_REQUEST", "recovery reason is required");
  }
  if (request.reason.length > 512) {
    throw new TeleportError("BAD_REQUEST", "recovery reason must be <= 512 chars");
  }
}
function validateImportRollback(request) {
  assertIdentifier(request.sessionId, "sessionId");
  assertIdentifier(request.importIdempotencyKey, "importIdempotencyKey");
  assertIdentifier(request.actorId, "actorId");
  safePositive(request.expectedRevision, "expectedRevision");
  safePositive(request.expectedNextSeq, "expectedNextSeq");
  safePositive(request.expectedWriterEpoch, "expectedWriterEpoch");
  if (typeof request.reason !== "string" || request.reason.trim().length === 0) {
    throw new TeleportError("BAD_REQUEST", "rollback reason is required");
  }
  if (request.reason.length > 512) {
    throw new TeleportError("BAD_REQUEST", "rollback reason must be <= 512 chars");
  }
}
function eventJson(event) {
  canonicalJson(event);
  return JSON.stringify(event);
}
function assertWriterCredentials(value) {
  if (value === null || typeof value !== "object") {
    throw new TeleportError("BAD_REQUEST", "writer credentials are required");
  }
  const writer = value;
  assertIdentifier(writer.deviceId, "writer.deviceId");
  assertIdentifier(writer.writerToken, "writer.writerToken");
  safeNonNegative(writer.writerEpoch, "writer.writerEpoch");
}
function assertIdentifier(value, name) {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new TeleportError("BAD_REQUEST", `${name} must be a non-empty string <= 256 chars`);
  }
}
function safeNonNegative(value, name) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TeleportError("BAD_REQUEST", `${name} must be a non-negative safe integer`);
  }
}
function safePositive(value, name) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new TeleportError("BAD_REQUEST", `${name} must be a positive safe integer`);
  }
}
function timestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("database created_at is not a timestamp");
  return date.toISOString();
}
function integer(value, name) {
  const result = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(result)) {
    throw new Error(`database ${name} is not a safe integer`);
  }
  return result;
}
export {
  TeleportAuthority
};
//# sourceMappingURL=authority.js.map
