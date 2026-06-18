import { EventEmitter } from 'events';

jest.mock('../../common/media/load-remote-media', () => ({
  loadRemoteMediaBuffer: jest.fn(),
}));

// A fake Baileys socket: an event emitter wearing the methods the adapter calls.
class FakeSock extends EventEmitter {
  public ev = {
    on: (event: string, handler: (arg: unknown) => void) => {
      this.emitter.on(event, handler);
    },
  };
  public emitter = new EventEmitter();
  public user: { id: string; name?: string } | undefined;
  public requestPairingCode = jest.fn().mockResolvedValue('ABCD-EFGH');
  public end = jest.fn();
  public logout = jest.fn().mockResolvedValue(undefined);
  public sendMessage = jest.fn();
  public onWhatsApp = jest.fn();
  public sendPresenceUpdate = jest.fn().mockResolvedValue(undefined);
  public groupFetchAllParticipating = jest.fn();
  public groupMetadata = jest.fn();
  public groupCreate = jest.fn();
  public groupParticipantsUpdate = jest.fn().mockResolvedValue(undefined);
  public groupLeave = jest.fn().mockResolvedValue(undefined);
  public groupUpdateSubject = jest.fn().mockResolvedValue(undefined);
  public groupUpdateDescription = jest.fn().mockResolvedValue(undefined);
  public groupInviteCode = jest.fn();
  public groupRevokeInvite = jest.fn();
  public profilePictureUrl = jest.fn();
  public updateBlockStatus = jest.fn().mockResolvedValue(undefined);
  fire(event: string, arg: unknown): void {
    this.emitter.emit(event, arg);
  }
  resetEmitter(): void {
    this.emitter.removeAllListeners();
  }
}

const fakeSock = new FakeSock();
const saveCreds = jest.fn().mockResolvedValue(undefined);

jest.mock('@whiskeysockets/baileys', () => ({
  __esModule: true,
  default: jest.fn(() => fakeSock),
  useMultiFileAuthState: jest.fn().mockResolvedValue({ state: { creds: {}, keys: {} }, saveCreds }),
  fetchLatestBaileysVersion: jest.fn().mockResolvedValue({ version: [2, 3000, 0] }),
  getContentType: jest.fn(() => 'conversation'),
  DisconnectReason: { loggedOut: 401, restartRequired: 515 },
}));

import { BaileysAdapter } from './baileys.adapter';
import { EngineStatus, EngineEventCallbacks } from '../interfaces/whatsapp-engine.interface';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
import { EngineNotSupportedError } from '../../common/errors/engine-not-supported.error';
import { loadRemoteMediaBuffer } from '../../common/media/load-remote-media';

const fakeStore = {
  put: jest.fn().mockResolvedValue(undefined),
  getMessage: jest.fn(),
  clearSession: jest.fn().mockResolvedValue(undefined),
};
const newAdapter = (): BaileysAdapter =>
  new BaileysAdapter({ sessionId: 'sess-1', authDir: './data/baileys', messageStore: fakeStore });

const noopCallbacks = (over: Partial<EngineEventCallbacks> = {}): EngineEventCallbacks => over;

describe('BaileysAdapter lifecycle & status', () => {
  beforeEach(() => {
    fakeSock.user = undefined;
    fakeSock.resetEmitter(); // drop listeners from previous test's initialize()
    jest.clearAllMocks();
  });

  it('starts DISCONNECTED', () => {
    expect(newAdapter().getStatus()).toBe(EngineStatus.DISCONNECTED);
  });

  it('emits onQRCode and moves to QR_READY on a connection.update with a qr', async () => {
    const onQRCode = jest.fn();
    const adapter = newAdapter();
    await adapter.initialize(noopCallbacks({ onQRCode }));
    fakeSock.fire('connection.update', { qr: 'QR-STRING' });
    expect(onQRCode).toHaveBeenCalledWith('QR-STRING');
    expect(adapter.getStatus()).toBe(EngineStatus.QR_READY);
    expect(adapter.getQRCode()).toBe('QR-STRING');
  });

  it('captures phone/pushName and fires onReady on connection open', async () => {
    const onReady = jest.fn();
    const adapter = newAdapter();
    await adapter.initialize(noopCallbacks({ onReady }));
    fakeSock.user = { id: '628999:12@s.whatsapp.net', name: 'Me' };
    fakeSock.fire('connection.update', { connection: 'open' });
    expect(adapter.getStatus()).toBe(EngineStatus.READY);
    expect(adapter.getPhoneNumber()).toBe('628999');
    expect(adapter.getPushName()).toBe('Me');
    expect(onReady).toHaveBeenCalledWith('628999', 'Me');
  });

  it('on a logged-out close: DISCONNECTED, onDisconnected, and NO reconnect', async () => {
    const onDisconnected = jest.fn();
    const adapter = newAdapter();
    await adapter.initialize(noopCallbacks({ onDisconnected }));
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const makeWASocket = jest.requireMock('@whiskeysockets/baileys').default as jest.Mock;
    makeWASocket.mockClear();
    fakeSock.fire('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 401 } } },
    });
    expect(adapter.getStatus()).toBe(EngineStatus.DISCONNECTED);
    expect(onDisconnected).toHaveBeenCalled();
    expect(makeWASocket).not.toHaveBeenCalled(); // no reconnect
  });

  it('on a recoverable close: reconnects (re-creates the socket) and does NOT fire onDisconnected', async () => {
    const onDisconnected = jest.fn();
    const adapter = newAdapter();
    await adapter.initialize(noopCallbacks({ onDisconnected }));
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const makeWASocket = jest.requireMock('@whiskeysockets/baileys').default as jest.Mock;
    makeWASocket.mockClear();
    fakeSock.fire('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 515 } } },
    });
    await new Promise(r => setImmediate(r)); // let the async connect() run
    expect(makeWASocket).toHaveBeenCalledTimes(1);
    expect(onDisconnected).not.toHaveBeenCalled();
  });

  it('disconnect() ends the socket and does not reconnect', async () => {
    const adapter = newAdapter();
    await adapter.initialize(noopCallbacks({}));
    await adapter.disconnect();
    expect(fakeSock.end).toHaveBeenCalled();
    expect(adapter.getStatus()).toBe(EngineStatus.DISCONNECTED);
  });

  it('requestPairingCode throws EngineNotReadyError before initialize()', async () => {
    const adapter = newAdapter();
    await expect(adapter.requestPairingCode('628999')).rejects.toBeInstanceOf(EngineNotReadyError);
  });

  it('requestPairingCode delegates to the socket', async () => {
    const adapter = newAdapter();
    await adapter.initialize(noopCallbacks({}));
    await expect(adapter.requestPairingCode('628999')).resolves.toBe('ABCD-EFGH');
    expect(fakeSock.requestPairingCode).toHaveBeenCalledWith('628999');
  });

  it('persists creds: subscribes saveCreds to creds.update', async () => {
    const adapter = newAdapter();
    await adapter.initialize(noopCallbacks({}));
    fakeSock.fire('creds.update', {});
    expect(saveCreds).toHaveBeenCalled();
  });
});

describe('BaileysAdapter capability gating', () => {
  it('throws EngineNotSupportedError for store-backed methods (e.g. getChats)', async () => {
    const adapter = newAdapter();
    await expect(adapter.getChats()).rejects.toBeInstanceOf(EngineNotSupportedError);
  });
});

describe('BaileysAdapter location + contact sends', () => {
  beforeEach(() => {
    fakeSock.user = { id: '628999:1@s.whatsapp.net', name: 'Me' };
    jest.clearAllMocks();
    fakeSock.sendMessage.mockResolvedValue({ key: { id: 'M2' }, messageTimestamp: 1700000006 });
  });

  const ready = async (): Promise<BaileysAdapter> => {
    const adapter = newAdapter();
    await adapter.initialize({});
    fakeSock.fire('connection.update', { connection: 'open' });
    return adapter;
  };

  it('sendLocationMessage maps lat/long + optional name/address', async () => {
    const adapter = await ready();
    await adapter.sendLocationMessage('628111@s.whatsapp.net', {
      latitude: 24.12,
      longitude: 55.11,
      description: 'Office',
      address: '1 Main St',
    });
    expect(fakeSock.sendMessage).toHaveBeenCalledWith('628111@s.whatsapp.net', {
      location: { degreesLatitude: 24.12, degreesLongitude: 55.11, name: 'Office', address: '1 Main St' },
    });
  });

  it('sendContactMessage builds a vCard with the waid', async () => {
    const adapter = await ready();
    await adapter.sendContactMessage('628111@s.whatsapp.net', { name: 'John Doe', number: '+1 234-567' });
    const [, call] = fakeSock.sendMessage.mock.calls[0] as [
      string,
      { contacts: { displayName: string; contacts: { vcard: string }[] } },
    ];
    expect(call.contacts.displayName).toBe('John Doe');
    const vcard = call.contacts.contacts[0].vcard;
    expect(vcard).toContain('FN:John Doe');
    expect(vcard).toContain('waid=1234567:+1 234-567');
    expect(vcard.startsWith('BEGIN:VCARD')).toBe(true);
  });

  it('sanitizes CRLF in a contact name to prevent vCard line-injection', async () => {
    const adapter = await ready();
    await adapter.sendContactMessage('628111@s.whatsapp.net', { name: 'Eve\nEMAIL:evil@x.com', number: '123' });
    const [, call] = fakeSock.sendMessage.mock.calls[0] as [string, { contacts: { contacts: { vcard: string }[] } }];
    const vcard = call.contacts.contacts[0].vcard;
    expect(vcard).not.toMatch(/\nEMAIL:evil@x\.com/);
    expect(vcard).toContain('FN:Eve EMAIL:evil@x.com');
  });
});

describe('BaileysAdapter messaging', () => {
  beforeEach(() => {
    fakeSock.user = { id: '628999:1@s.whatsapp.net', name: 'Me' };
    jest.clearAllMocks();
  });

  const readyAdapter = async (over: Partial<EngineEventCallbacks> = {}): Promise<BaileysAdapter> => {
    const adapter = newAdapter();
    await adapter.initialize(over);
    fakeSock.fire('connection.update', { connection: 'open' });
    return adapter;
  };

  it('sendTextMessage calls sock.sendMessage(jid, { text }) and returns the message id', async () => {
    fakeSock.sendMessage.mockResolvedValue({ key: { id: 'OUT1' }, messageTimestamp: 1700000001 });
    const adapter = await readyAdapter();
    const res = await adapter.sendTextMessage('628111@s.whatsapp.net', 'hello');
    expect(fakeSock.sendMessage).toHaveBeenCalledWith('628111@s.whatsapp.net', { text: 'hello' });
    expect(res).toEqual({ id: 'OUT1', timestamp: 1700000001 });
  });

  it('getNumberId resolves via onWhatsApp and returns the jid when it exists', async () => {
    fakeSock.onWhatsApp.mockResolvedValue([{ jid: '628111@s.whatsapp.net', exists: true }]);
    const adapter = await readyAdapter();
    await expect(adapter.getNumberId('628111')).resolves.toBe('628111@s.whatsapp.net');
    await expect(adapter.checkNumberExists('628111')).resolves.toBe(true);
  });

  it('getNumberId returns null when the number is not on WhatsApp', async () => {
    fakeSock.onWhatsApp.mockResolvedValue([{ jid: '628111@s.whatsapp.net', exists: false }]);
    const adapter = await readyAdapter();
    await expect(adapter.getNumberId('628111')).resolves.toBeNull();
    await expect(adapter.checkNumberExists('628111')).resolves.toBe(false);
  });

  it('sendChatState maps typing -> composing presence', async () => {
    const adapter = await readyAdapter();
    await adapter.sendChatState('628111@s.whatsapp.net', 'typing');
    expect(fakeSock.sendPresenceUpdate).toHaveBeenCalledWith('composing', '628111@s.whatsapp.net');
  });

  it('messaging methods throw EngineNotReadyError before the connection is open', async () => {
    const adapter = newAdapter();
    await adapter.initialize({});
    await expect(adapter.sendTextMessage('x', 'y')).rejects.toBeInstanceOf(EngineNotReadyError);
    await expect(adapter.checkNumberExists('628111')).rejects.toBeInstanceOf(EngineNotReadyError);
    await expect(adapter.getNumberId('628111')).rejects.toBeInstanceOf(EngineNotReadyError);
    await expect(adapter.sendChatState('628111@s.whatsapp.net', 'typing')).rejects.toBeInstanceOf(EngineNotReadyError);
  });
});

describe('BaileysAdapter inbound fan-out', () => {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  const baileys = jest.requireMock('@whiskeysockets/baileys') as { getContentType: jest.Mock };

  beforeEach(() => {
    fakeSock.user = { id: '628999:1@s.whatsapp.net', name: 'Me' };
    jest.clearAllMocks();
    baileys.getContentType.mockReturnValue('conversation');
  });

  it('routes an inbound (not fromMe) message to onMessage with a neutral shape', async () => {
    const onMessage = jest.fn();
    const adapter = newAdapter();
    await adapter.initialize({ onMessage });
    fakeSock.fire('messages.upsert', {
      type: 'notify',
      messages: [
        {
          key: { remoteJid: '628111@s.whatsapp.net', fromMe: false, id: 'IN1' },
          message: { conversation: 'hi there' },
          messageTimestamp: 1700000002,
          pushName: 'Alice',
        },
      ],
    });
    expect(onMessage).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const msg = onMessage.mock.calls[0][0] as { id: string; body: string; type: string; fromMe: boolean };
    expect(msg).toMatchObject({ id: 'IN1', body: 'hi there', type: 'text', fromMe: false });
  });

  it('routes a fromMe message to onMessageCreate (outgoing), not onMessage', async () => {
    const onMessage = jest.fn();
    const onMessageCreate = jest.fn();
    const adapter = newAdapter();
    await adapter.initialize({ onMessage, onMessageCreate });
    fakeSock.fire('messages.upsert', {
      type: 'notify',
      messages: [
        {
          key: { remoteJid: '628111@s.whatsapp.net', fromMe: true, id: 'OUT2' },
          message: { conversation: 'sent from phone' },
          messageTimestamp: 1700000003,
        },
      ],
    });
    expect(onMessageCreate).toHaveBeenCalledTimes(1);
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('ignores append (history) upserts', async () => {
    const onMessage = jest.fn();
    const adapter = newAdapter();
    await adapter.initialize({ onMessage });
    fakeSock.fire('messages.upsert', {
      type: 'append',
      messages: [
        { key: { remoteJid: '628111@s.whatsapp.net', fromMe: false, id: 'OLD' }, message: { conversation: 'old' } },
      ],
    });
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('emits onMessageAck from messages.update with a neutral status', async () => {
    const onMessageAck = jest.fn();
    const adapter = newAdapter();
    await adapter.initialize({ onMessageAck });
    fakeSock.fire('messages.update', [{ key: { id: 'OUT1' }, update: { status: 3 } }]);
    expect(onMessageAck).toHaveBeenCalledWith('OUT1', 'delivered');
  });
});

describe('BaileysAdapter media sends', () => {
  beforeEach(() => {
    fakeSock.user = { id: '628999:1@s.whatsapp.net', name: 'Me' };
    jest.clearAllMocks();
    fakeSock.sendMessage.mockResolvedValue({ key: { id: 'M1' }, messageTimestamp: 1700000005 });
  });

  const ready = async (): Promise<BaileysAdapter> => {
    const adapter = newAdapter();
    await adapter.initialize({});
    fakeSock.fire('connection.update', { connection: 'open' });
    return adapter;
  };

  it('sendImageMessage sends a Buffer image with caption + mimetype', async () => {
    const adapter = await ready();
    const buf = Buffer.from([1, 2, 3]);
    const res = await adapter.sendImageMessage('628111@s.whatsapp.net', {
      mimetype: 'image/png',
      data: buf,
      caption: 'hi',
    });
    expect(fakeSock.sendMessage).toHaveBeenCalledWith('628111@s.whatsapp.net', {
      image: buf,
      caption: 'hi',
      mimetype: 'image/png',
    });
    expect(res).toEqual({ id: 'M1', timestamp: 1700000005 });
  });

  it('resolves a base64 data string to a Buffer (no URL fetch)', async () => {
    const adapter = await ready();
    await adapter.sendDocumentMessage('628111@s.whatsapp.net', {
      mimetype: 'application/pdf',
      data: Buffer.from('PDFDATA').toString('base64'),
      filename: 'doc.pdf',
    });
    expect(loadRemoteMediaBuffer).not.toHaveBeenCalled();
    expect(fakeSock.sendMessage).toHaveBeenCalledWith('628111@s.whatsapp.net', {
      document: Buffer.from('PDFDATA'),
      mimetype: 'application/pdf',
      fileName: 'doc.pdf',
    });
  });

  it('fetches a URL data string through the SSRF-guarded loader', async () => {
    (loadRemoteMediaBuffer as jest.Mock).mockResolvedValue({ data: Buffer.from([9]), mimetype: 'video/mp4' });
    const adapter = await ready();
    await adapter.sendVideoMessage('628111@s.whatsapp.net', { mimetype: '', data: 'https://cdn.example/v.mp4' });
    expect(loadRemoteMediaBuffer).toHaveBeenCalledWith('https://cdn.example/v.mp4');
    expect(fakeSock.sendMessage).toHaveBeenCalledWith('628111@s.whatsapp.net', {
      video: Buffer.from([9]),
      caption: undefined,
      mimetype: 'video/mp4',
    });
  });

  it('sendAudioMessage sets ptt:false', async () => {
    const adapter = await ready();
    await adapter.sendAudioMessage('628111@s.whatsapp.net', { mimetype: 'audio/mp4', data: Buffer.from([1]) });
    expect(fakeSock.sendMessage).toHaveBeenCalledWith('628111@s.whatsapp.net', {
      audio: Buffer.from([1]),
      mimetype: 'audio/mp4',
      ptt: false,
    });
  });

  it('sendStickerMessage sends the sticker buffer', async () => {
    const adapter = await ready();
    await adapter.sendStickerMessage('628111@s.whatsapp.net', { mimetype: 'image/webp', data: Buffer.from([7]) });
    expect(fakeSock.sendMessage).toHaveBeenCalledWith('628111@s.whatsapp.net', { sticker: Buffer.from([7]) });
  });

  it('uses the caller-declared mimetype over the fetched content-type for a URL', async () => {
    (loadRemoteMediaBuffer as jest.Mock).mockResolvedValue({
      data: Buffer.from([1]),
      mimetype: 'application/octet-stream',
    });
    const adapter = await ready();
    await adapter.sendImageMessage('628111@s.whatsapp.net', { mimetype: 'image/png', data: 'https://cdn.example/x' });
    expect(fakeSock.sendMessage).toHaveBeenCalledWith('628111@s.whatsapp.net', {
      image: Buffer.from([1]),
      caption: undefined,
      mimetype: 'image/png',
    });
  });

  it('media sends reject with EngineNotReadyError before the connection is open', async () => {
    const adapter = newAdapter();
    await adapter.initialize({});
    await expect(
      adapter.sendImageMessage('x', { mimetype: 'image/png', data: Buffer.from([1]) }),
    ).rejects.toBeInstanceOf(EngineNotReadyError);
  });
});

describe('BaileysAdapter store-backed ops', () => {
  beforeEach(() => {
    fakeSock.user = { id: '628999:1@s.whatsapp.net', name: 'Me' };
    jest.clearAllMocks();
    fakeSock.sendMessage.mockResolvedValue({
      key: { id: 'OUT', remoteJid: '628111@s.whatsapp.net', fromMe: true },
      messageTimestamp: 1700000009,
    });
  });

  const ready = async (): Promise<BaileysAdapter> => {
    const adapter = newAdapter();
    await adapter.initialize({});
    fakeSock.fire('connection.update', { connection: 'open' });
    return adapter;
  };

  const stored = {
    key: { id: 'TARGET', remoteJid: '628111@s.whatsapp.net', fromMe: false },
    message: { conversation: 'hi' },
  };

  it('replyToMessage quotes the stored message', async () => {
    fakeStore.getMessage.mockResolvedValue(stored);
    const adapter = await ready();
    await adapter.replyToMessage('628111@s.whatsapp.net', 'TARGET', 'my reply');
    expect(fakeStore.getMessage).toHaveBeenCalledWith('sess-1', 'TARGET');
    expect(fakeSock.sendMessage).toHaveBeenCalledWith(
      '628111@s.whatsapp.net',
      { text: 'my reply' },
      { quoted: stored },
    );
  });

  it('forwardMessage forwards the stored message', async () => {
    fakeStore.getMessage.mockResolvedValue(stored);
    const adapter = await ready();
    await adapter.forwardMessage('628111@s.whatsapp.net', '628222@s.whatsapp.net', 'TARGET');
    expect(fakeSock.sendMessage).toHaveBeenCalledWith('628222@s.whatsapp.net', { forward: stored });
  });

  it('reactToMessage sends the stored key', async () => {
    fakeStore.getMessage.mockResolvedValue(stored);
    const adapter = await ready();
    await adapter.reactToMessage('628111@s.whatsapp.net', 'TARGET', '👍');
    expect(fakeSock.sendMessage).toHaveBeenCalledWith('628111@s.whatsapp.net', {
      react: { text: '👍', key: stored.key },
    });
  });

  it('deleteMessage revokes via the stored key', async () => {
    fakeStore.getMessage.mockResolvedValue(stored);
    const adapter = await ready();
    await adapter.deleteMessage('628111@s.whatsapp.net', 'TARGET', true);
    expect(fakeSock.sendMessage).toHaveBeenCalledWith('628111@s.whatsapp.net', { delete: stored.key });
  });

  it('throws when the referenced message is not in the store', async () => {
    fakeStore.getMessage.mockResolvedValue(null);
    const adapter = await ready();
    await expect(adapter.replyToMessage('c', 'GONE', 'x')).rejects.toThrow(/not found/i);
  });

  it('deleteMessage for-me (forEveryone=false) is not supported', async () => {
    const adapter = await ready();
    await expect(adapter.deleteMessage('c', 'TARGET', false)).rejects.toBeInstanceOf(EngineNotSupportedError);
  });

  it('populates the store on an inbound message', async () => {
    const adapter = newAdapter();
    await adapter.initialize({});
    fakeSock.fire('messages.upsert', {
      type: 'notify',
      messages: [
        { key: { remoteJid: '628111@s.whatsapp.net', fromMe: false, id: 'IN9' }, message: { conversation: 'hi' } },
      ],
    });
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const inboundMatcher = expect.objectContaining({ key: expect.objectContaining({ id: 'IN9' }) });
    expect(fakeStore.put).toHaveBeenCalledWith('sess-1', inboundMatcher);
  });

  it('populates the store on an outgoing send', async () => {
    const adapter = await ready();
    await adapter.sendTextMessage('628111@s.whatsapp.net', 'hello');
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const outboundMatcher = expect.objectContaining({ key: expect.objectContaining({ id: 'OUT' }) });
    expect(fakeStore.put).toHaveBeenCalledWith('sess-1', outboundMatcher);
  });

  it('clears the store on logout', async () => {
    const adapter = await ready();
    await adapter.logout();
    expect(fakeStore.clearSession).toHaveBeenCalledWith('sess-1');
  });
});

describe('BaileysAdapter group management', () => {
  const META = {
    id: '123-456@g.us',
    subject: 'G',
    participants: [{ id: '628999@s.whatsapp.net', admin: 'superadmin' }],
  };

  beforeEach(() => {
    fakeSock.user = { id: '628999:1@s.whatsapp.net', name: 'Me' };
    jest.clearAllMocks();
  });

  const ready = async (): Promise<BaileysAdapter> => {
    const adapter = newAdapter();
    await adapter.initialize({});
    fakeSock.fire('connection.update', { connection: 'open' });
    return adapter;
  };

  it('getGroups maps groupFetchAllParticipating', async () => {
    fakeSock.groupFetchAllParticipating.mockResolvedValue({ '123-456@g.us': META });
    const adapter = await ready();
    const groups = await adapter.getGroups();
    expect(groups).toEqual([
      { id: '123-456@g.us', name: 'G', participantsCount: 1, isAdmin: true, linkedParentJID: null },
    ]);
  });

  it('getGroupInfo maps groupMetadata, and returns null when it rejects', async () => {
    fakeSock.groupMetadata.mockResolvedValueOnce(META);
    const adapter = await ready();
    expect((await adapter.getGroupInfo('123-456@g.us'))?.id).toBe('123-456@g.us');
    fakeSock.groupMetadata.mockRejectedValueOnce(new Error('not a group'));
    expect(await adapter.getGroupInfo('x@g.us')).toBeNull();
  });

  it('createGroup returns the mapped new group', async () => {
    fakeSock.groupCreate.mockResolvedValue(META);
    const adapter = await ready();
    const g = await adapter.createGroup('G', ['628111@s.whatsapp.net']);
    expect(fakeSock.groupCreate).toHaveBeenCalledWith('G', ['628111@s.whatsapp.net']);
    expect(g.id).toBe('123-456@g.us');
  });

  it.each([
    ['addParticipants', 'add'],
    ['removeParticipants', 'remove'],
    ['promoteParticipants', 'promote'],
    ['demoteParticipants', 'demote'],
  ])('%s calls groupParticipantsUpdate with %s', async (method, action) => {
    const adapter = await ready();
    await (adapter as unknown as Record<string, (g: string, p: string[]) => Promise<void>>)[method]('123-456@g.us', [
      '628111@s.whatsapp.net',
    ]);
    expect(fakeSock.groupParticipantsUpdate).toHaveBeenCalledWith('123-456@g.us', ['628111@s.whatsapp.net'], action);
  });

  it('leaveGroup / setGroupSubject / setGroupDescription delegate to the socket', async () => {
    const adapter = await ready();
    await adapter.leaveGroup('123-456@g.us');
    expect(fakeSock.groupLeave).toHaveBeenCalledWith('123-456@g.us');
    await adapter.setGroupSubject('123-456@g.us', 'New');
    expect(fakeSock.groupUpdateSubject).toHaveBeenCalledWith('123-456@g.us', 'New');
    await adapter.setGroupDescription('123-456@g.us', 'Desc');
    expect(fakeSock.groupUpdateDescription).toHaveBeenCalledWith('123-456@g.us', 'Desc');
  });

  it('getGroupInviteCode / revokeGroupInviteCode return the code', async () => {
    fakeSock.groupInviteCode.mockResolvedValue('ABC123');
    fakeSock.groupRevokeInvite.mockResolvedValue('NEW456');
    const adapter = await ready();
    expect(await adapter.getGroupInviteCode('123-456@g.us')).toBe('ABC123');
    expect(await adapter.revokeGroupInviteCode('123-456@g.us')).toBe('NEW456');
  });

  it('group ops reject with EngineNotReadyError before connect', async () => {
    const adapter = newAdapter();
    await adapter.initialize({});
    await expect(adapter.getGroups()).rejects.toBeInstanceOf(EngineNotReadyError);
  });
});
