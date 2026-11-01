import {
  NativeEventEmitter,
  NativeModules,
  DeviceEventEmitter,
  Alert,
} from 'react-native';

import notifee, { AndroidImportance } from '@notifee/react-native';
import { Client } from '@stomp/stompjs';
import * as encoding from 'text-encoding'; //do not remove this (polyfills for TextEncoder/TextDecoder stompjs)
import { xxHash32 } from 'js-xxhash';
import AesGcmCrypto from 'react-native-aes-gcm-crypto';
import { Buffer } from 'buffer';
import {
  RTCPeerConnection,
  RTCIceCandidate,
  RTCSessionDescription,
} from 'react-native-webrtc';
import Clipboard from '@react-native-clipboard/clipboard';
const {loadIceServerConfig} = require('./IceServerConfig');
import {checkForUpdates} from './UpdateChecker';

import {
  setDataInAsyncStorage,
  getDataFromAsyncStorage,
  getMultipleDataFromAsyncStorage,
  clearAsyncStorage,
} from './AsyncStorageManagement';

function cleanupClipboardListeners() {
  DeviceEventEmitter.removeAllListeners('SHARED_TEXT');
  DeviceEventEmitter.removeAllListeners('SHARED_IMAGE');
  DeviceEventEmitter.removeAllListeners('SHARED_FILES');
  DeviceEventEmitter.removeAllListeners('onClipboardChange');
}

module.exports = async (inputData = null) => {
  // Constants
  const SUBSCRIPTION_DESTINATION = '/user/queue/cliptext';
  const SEND_DESTINATION = '/app/cliptext';
  const RECONNECT_WS_TIMER = 10000; // 10 seconds
  const HEARTBEAT_INTERVAL = 20000; // 20 seconds
  const FRAGMENT_SIZE = 15360; // 15 KiB
  const FRAGMENT_TTL_MS = 60000; // drop partial fragment buffers idle for 60s
  const STOMP_DEACTIVATE_TIMEOUT_MS = 5000; // bound the STOMP deactivate() wait

  // forground service
  notifee.registerForegroundService(notification => {
    return new Promise(async () => {
      try {
        const { NativeBridgeModule } = NativeModules;
        // Restore trust before either WebSocket mode starts, including headless boot.
        await NativeModules.ServerTlsModule.configure(
          await getDataFromAsyncStorage('server_url'),
          (await getDataFromAsyncStorage('ssl_ca_bundle')) || '',
        );
        const textEncoder = new TextEncoder();
        const textDecoder = new TextDecoder();

        let previous_clipboard_content_hash = '';
        let toggle = false; // p2s toggle
        let files_in_memory = null;
        let websocket_status_notification_toggle = false;
        let p2pMsg = null; // p2p status message

        let stompClient = null;
        let wsSignalingClient = null;
        let sendClipBoardP2S = null;
        let sendClipBoardP2P = null;
        let stopServicesP2S = null;
        let stopServicesP2P = null;
        let getP2PStatusMessage = null;
        let isP2PStatusMsgChanged = false;

        // get data from async storage
        const {
          websocket_url,
          cipher_enabled,
          maxsize: maxsizeStr,
          server_mode,
          stun_url,
          enable_image_sharing,
          enable_file_sharing,
          enable_websocket_status_notification,
          max_clipboard_size_local_limit_bytes: maxClipboardLimitStr,
        } = await getMultipleDataFromAsyncStorage([
          'websocket_url',
          'cipher_enabled',
          'maxsize',
          'server_mode',
          'stun_url',
          'enable_image_sharing',
          'enable_file_sharing',
          'enable_websocket_status_notification',
          'max_clipboard_size_local_limit_bytes',
        ]);

        const maxsize = Number(maxsizeStr);
        let max_clipboard_size_local_limit_bytes = Number(maxClipboardLimitStr);
        if (max_clipboard_size_local_limit_bytes === 0) {
          max_clipboard_size_local_limit_bytes = maxsize;
        }

        // encrption
        const encrypt = async plainText => {
          try {
            const encryptedData = await AesGcmCrypto.encrypt(
              plainText,
              false,
              await getDataFromAsyncStorage('hashed_password'),
            );
            return JSON.stringify({
              nonce: Buffer.from(encryptedData.iv, 'hex').toString('base64'),
              ciphertext: encryptedData.content,
              tag: Buffer.from(encryptedData.tag, 'hex').toString('base64'),
            });
          } catch (e) {
            throw new Error('Failed to encrypt: ' + e);
          }
        };

        // decryption
        const decrypt = async encryptedData => {
          try {
            const plainText = await AesGcmCrypto.decrypt(
              encryptedData['ciphertext'],
              await getDataFromAsyncStorage('hashed_password'),
              Buffer.from(encryptedData['nonce'], 'base64').toString('hex'),
              Buffer.from(encryptedData['tag'], 'base64').toString('hex'),
              false,
            );
            return plainText;
          } catch (e) {
            throw new Error('Failed to decrypt: ' + e);
          }
        };

        // hash clipboard content
        const hashCB = async (input, seed = 0) => {
          return String(xxHash32(input, seed));
        };

        //check if clipboard content changed
        const newCB = async hcb => {
          return previous_clipboard_content_hash !== hcb;
        };

        const calculateBase64DecodedLength = async base64Str => {
          // Calculates the decoded byte length of a Base64-encoded string.
          const n = base64Str.length;
          const padding = (base64Str.match(/=/g) || []).length;
          return 3 * (n / 4) - padding;
        };

        // fragment string into chunks
        const fragmentString = async (str, fragmentSize) => {
          if (!Number.isInteger(fragmentSize) || fragmentSize < 4) {
            throw new Error(
              'fragmentSize must be an integer of at least 4 bytes',
            );
          }
          const bytes = textEncoder.encode(str); // convert to UTF-8 bytes
          const fragments = [];
          let start = 0;
          while (start < bytes.length) {
            let end = Math.min(start + fragmentSize, bytes.length);
            // Move the boundary back to the start of any split UTF-8 character.
            while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) {
              end -= 1;
            }
            const chunk = bytes.slice(start, end);
            fragments.push(textDecoder.decode(chunk));
            start = end;
          }
          return fragments;
        };

        // generate uuid
        const generateUuid = async () => {
          return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
            const r = (Math.random() * 16) | 0;
            const v = c === 'x' ? r : (r & 0x3) | 0x8;
            return v.toString(16);
          });
        };

        const p2pStatusMessageChanged = async () => {
          isP2PStatusMsgChanged = true;
        };

        // validate clipboard size
        const validateClipboardSize = async (clipContent, type, direction) => {
          let clipContentByteLength = 0;
          if (type === 'text') {
            clipContentByteLength = Buffer.byteLength(clipContent, 'utf8');
          } else if (type === 'image') {
            if (
              direction.toLowerCase() === 'outbound' &&
              typeof clipContent === 'string'
            ) {
              clipContentByteLength = Number(
                await NativeBridgeModule.getFileSize(clipContent),
              );
            } else if (direction.toLowerCase() === 'inbound') {
              clipContentByteLength = await calculateBase64DecodedLength(
                clipContent,
              );
            }
          } else if (type === 'files') {
            if (
              direction.toLowerCase() === 'outbound' &&
              typeof clipContent === 'string'
            ) {
              const file_paths = clipContent
                .split(',')
                .filter(item => item.trim() !== '');
              for (const file_path of file_paths) {
                clipContentByteLength += Number(
                  await NativeBridgeModule.getFileSize(file_path),
                );
              }
            } else if (direction.toLowerCase() === 'inbound') {
              let files = JSON.parse(clipContent);
              for (const file in files) {
                clipContentByteLength += await calculateBase64DecodedLength(
                  files[file],
                );
              }
            }
          } else {
            return false;
          }

          if (server_mode === 'P2S') {
            if (
              clipContentByteLength <= maxsize &&
              clipContentByteLength <= max_clipboard_size_local_limit_bytes
            ) {
              return true;
            }
            await setDataInAsyncStorage(
              'wsStatusMessage',
              '⚠️ ' +
                direction +
                ' clipboard ignored: size (' +
                clipContentByteLength +
                ' bytes) exceeds limits; Server max size (' +
                maxsize +
                ' bytes) or Local max size (' +
                max_clipboard_size_local_limit_bytes +
                ' bytes)',
            );
          } else if (server_mode === 'P2P') {
            if (
              max_clipboard_size_local_limit_bytes < 0 ||
              clipContentByteLength <= max_clipboard_size_local_limit_bytes
            ) {
              return true;
            }

            p2pMsg =
              '⚠️ ' +
              direction +
              ' clipboard ignored: size (' +
              clipContentByteLength +
              ' bytes) exceeds limits; Local max size (' +
              max_clipboard_size_local_limit_bytes +
              ' bytes)';
            await p2pStatusMessageChanged();
          }

          return false;
        };

        // Event triggered when text content is shared with the app. (or) when text selection popup menu action is invoked
        DeviceEventEmitter.addListener('SHARED_TEXT', async event => {
          try {
            const clipContent = event.text;
            if (clipContent) {
              /**
               * Sometimes `Clipboard.setString` is invoked before the app is fully opened, leading to an unauthorized state.
               * To handle this, implement a fail-safe mechanism that retries sending clipboard content only when it hasn't been successfully sent yet.
               * If both events are triggered successfully, the content won't be sent twice because the same content is hashed, ensuring that identical data is only processed once.
               */
              Clipboard.setString(clipContent);
              await sendClipBoard(clipContent, 'text');
            }
          } catch (e) {
            await setDataInAsyncStorage(
              'wsStatusMessage',
              '❌ Outbound Error: ' + e,
            );
          }
        });

        // Event listener triggered when image is shared with the app.
        DeviceEventEmitter.addListener('SHARED_IMAGE', async event => {
          try {
            const clipContent = event.image;
            if (clipContent) {
              await sendClipBoard(clipContent, 'image');
            }
          } catch (e) {
            await setDataInAsyncStorage(
              'wsStatusMessage',
              '❌ Outbound Error: ' + e,
            );
          }
        });

        // Event listener triggered when files are shared with the app.
        DeviceEventEmitter.addListener('SHARED_FILES', async event => {
          try {
            const clipContent = event.files;
            if (clipContent) {
              await sendClipBoard(clipContent, 'files');
            }
          } catch (e) {
            await setDataInAsyncStorage(
              'wsStatusMessage',
              '❌ Outbound Error: ' + e,
            );
          }
        });

        //clipboard monitor
        const { ClipboardListener } = NativeModules;
        // In-memory stage counters; never pass clipboard payloads or URI strings.
        const noteClipboardStage = stage => {
          try { ClipboardListener?.recordTransportStage?.(stage); } catch (_) {}
        };
        const clipboardListener = new NativeEventEmitter(ClipboardListener);
        // start clipboard listening
        ClipboardListener.startListening();
        // clipboard listener callback
        const clipboardOnChange = clipboardListener.addListener(
          'onClipboardChange',
          async params => {
            try {
              if (params && params.content && params.type) {
                noteClipboardStage('js-' + params.type);
                await sendClipBoard(params.content, params.type);
              }
            } catch (e) {
              await setDataInAsyncStorage(
                'wsStatusMessage',
                '❌ Outbound Error: ' + e,
              );
            }
          },
        );

        const clearFiles = async (expensiveCall = false) => {
          files_in_memory = null;
          if (!expensiveCall) {
            await notifee.cancelNotification(
              'ClipCascade_Download_Files_Notification_Id',
            );
            await setDataInAsyncStorage('filesAvailableToDownload', 'false');
            await setDataInAsyncStorage('downloadFiles', 'false');
            await setDataInAsyncStorage('dirPath', '');
          }
        };

        const showFilesDownloadNotification = async msg => {
          // Display a silent notification
          await notifee.displayNotification({
            id: 'ClipCascade_Download_Files_Notification_Id',
            title: msg,
            android: {
              channelId: 'ClipCascade',
              smallIcon: 'ic_small_icon',
              color: 'gray',
              pressAction: {
                id: 'default',
                launchActivity: 'default',
              },
            },
          });
        };

        const showWebSocketStatusNotification = async (
          msg,
          timeout = 10000,
        ) => {
          await notifee.displayNotification({
            id: 'ClipCascade_WebSocket_Status_Notification_Id',
            title: msg,
            android: {
              channelId: 'ClipCascade_Connection_Status',
              smallIcon: 'ic_small_icon',
              pressAction: {
                id: 'default',
                launchActivity: 'default',
              },
              timeoutAfter: timeout === -1 ? undefined : timeout,
            },
          });
        };

        if (server_mode === 'P2S') {
          // websocket stomp client
          stompClient = new Client({
            brokerURL: websocket_url,
            reconnectDelay: RECONNECT_WS_TIMER,
            connectionTimeout: 5000,
            heartbeatIncoming: HEARTBEAT_INTERVAL,
            heartbeatOutgoing: 0,
            forceBinaryWSFrames: true, // https://stomp-js.github.io/api-docs/latest/classes/Client.html#forceBinaryWSFrames
            // appendMissingNULLonIncoming: true, // https://stomp-js.github.io/api-docs/latest/classes/Client.html#appendMissingNULLonIncoming
            onConnect: async () => {
              await setDataInAsyncStorage('wsStatusMessage', '✅ Connected');

              toggle = false;
              // Subscribe to a topic
              stompClient.subscribe(SUBSCRIPTION_DESTINATION, async message => {
                try {
                  await clearFiles();
                  toggle = false;
                  await setDataInAsyncStorage(
                    'wsStatusMessage',
                    '✅ Connected - Subscribed',
                  );

                  if (message && message.body) {
                    const body = JSON.parse(message.body);
                    let cb = String(body.payload);
                    const type_ = body.type ?? 'text';

                    //decrypt
                    if (cipher_enabled === 'true') {
                      try {
                        cb = await decrypt(JSON.parse(cb));
                      } catch (error) {
                        throw new Error(
                          `Encryption must be enabled on all devices if enabled. JSON parsing failed: ${error.message}`,
                        );
                      }
                    }

                    // hash clipboard content
                    const hcb = await hashCB(cb);
                    if (await newCB(hcb)) {
                      previous_clipboard_content_hash = hcb;

                      // validate clipboard size
                      if (await validateClipboardSize(cb, type_, 'Inbound')) {
                        // set clipboard content
                        if (type_ === 'text') {
                          Clipboard.setString(cb);
                        } else if (type_ === 'image') {
                          await NativeBridgeModule.copyBase64ImageToClipboardUsingCache(
                            cb,
                          );
                        } else if (type_ === 'files') {
                          await showFilesDownloadNotification(
                            '📥 Download File(s)',
                          );

                          files_in_memory = cb;
                          await setDataInAsyncStorage(
                            'filesAvailableToDownload',
                            'true',
                          );
                        }
                      }
                    }
                  }
                } catch (e) {
                  await setDataInAsyncStorage(
                    'wsStatusMessage',
                    '❌ Inbound Error: ' + e,
                  );
                }
              });

              if (enable_websocket_status_notification === 'true') {
                if (websocket_status_notification_toggle == true) {
                  websocket_status_notification_toggle = false;
                  await showWebSocketStatusNotification(
                    'WebSocket Connection Restored 🔗',
                  );
                } else {
                  await notifee.cancelNotification(
                    'ClipCascade_WebSocket_Status_Notification_Id',
                  );
                }
              }
            },
            onDisconnect: async () => {
              await setDataInAsyncStorage('wsStatusMessage', 'Disconnected');
            },
            onStompError: async frame => {
              await setDataInAsyncStorage(
                'wsStatusMessage',
                '❌ STOMP Error: ' + JSON.stringify(frame, null, 2),
              );
            },
            onWebSocketError: async event => {
              await setDataInAsyncStorage(
                'wsStatusMessage',
                '❌ WebSocket Error: ' + JSON.stringify(event, null, 2),
              );
            },
            onWebSocketClose: async event => {
              const reason = event?.reason || 'closed by client';
              await setDataInAsyncStorage(
                'wsStatusMessage',
                `⚠️ WebSocket Close: ${reason}`,
              );
              if (
                enable_websocket_status_notification === 'true' &&
                websocket_status_notification_toggle == false &&
                (await getDataFromAsyncStorage('wsIsRunning')) === 'true'
              ) {
                websocket_status_notification_toggle = true;
                await showWebSocketStatusNotification(
                  'WebSocket Connection Lost ⛓️‍💥',
                  -1,
                );
              }
            },
          });

          // start websocket stomp connection
          stompClient.activate();

          // send clipboard content P2S
          sendClipBoardP2S = async (clipContent, type_ = 'text') => {
            try {
              await clearFiles();
              if (stompClient && stompClient.connected && !toggle) {
                if (
                  (type_ === 'image' && enable_image_sharing === 'false') ||
                  (type_ === 'files' && enable_file_sharing === 'false')
                ) {
                  return;
                }

                if (
                  await validateClipboardSize(clipContent, type_, 'Outbound')
                ) {
                  // base64 encode
                  if (type_ === 'image') {
                    clipContent = await NativeBridgeModule.getClipboardImageAsBase64(
                      clipContent,
                    );
                  } else if (type_ === 'files') {
                    temp = {};
                    const file_paths = clipContent
                      .split(',')
                      .filter(item => item.trim() !== '');

                    for (const file_path of file_paths) {
                      temp[await NativeBridgeModule.getFileName(file_path)] =
                        await NativeBridgeModule.getFileAsBase64(file_path);
                    }
                    clipContent = JSON.stringify(temp);
                  }

                  // clipboad content hash
                  const hcb = await hashCB(clipContent);
                  if (await newCB(hcb)) {
                    previous_clipboard_content_hash = hcb;

                    
                      toggle = true;

                      if (cipher_enabled === 'true') {
                        //ecrypt
                        clipContent = await encrypt(clipContent);
                      }

                      await setDataInAsyncStorage(
                        'wsStatusMessage',
                        '✅ Connected - Broadcasting',
                      );

                      // send
                      stompClient.publish({
                        destination: SEND_DESTINATION,
                        body: JSON.stringify({
                          payload: String(clipContent),
                          type: type_,
                        }),
                      });
                    
                  }
                }
              }
            } catch (e) {
              toggle = false;
              throw e;
            }
          };

          // stop events and connection P2S
          stopServicesP2S = async () => {
            // 1) Stop clipboard listening
            try {
              await ClipboardListener.stopListening();
              if (clipboardOnChange) {
                clipboardOnChange.remove();
              }
            } catch (e) {
              // no-op
            }

            // 2) Deactivate STOMP client safely
            if (stompClient) {
              // Remove stomp event handlers
              stompClient.onConnect = null;
              stompClient.onDisconnect = null;
              stompClient.onStompError = null;
              stompClient.onWebSocketError = null;
              stompClient.onWebSocketClose = () => {};

              // Deactivate the stomp connection, but don't hang here forever:
              // some socket states cause deactivate() to never resolve, which
              // would prevent the foreground service from stopping.
              try {
                await Promise.race([
                  stompClient.deactivate(),
                  new Promise(resolve =>
                    setTimeout(resolve, STOMP_DEACTIVATE_TIMEOUT_MS),
                  ),
                ]);
              } catch (e) {
                // no-op
              }
            }
            stompClient = null;

            await setDataInAsyncStorage('wsStatusMessage', '✅ Disconnected');
            cleanupClipboardListeners();
            await notifee.stopForegroundService();
          };
        } else if (server_mode === 'P2P') {
          // p2p variables
          let myPeerId = null; // Your assigned peer ID from server
          let peers = new Set(); // Current set of known peer IDs in the "room"
          let peerConnections = {}; // Map: peerId -> RTCPeerConnection
          let dataChannels = {}; // Map: peerId -> RTCDataChannel
          let liveConnectionsCount = 0; // Track open DataChannels
          let pendingPeerList = null;
          let p2pShuttingDown = false;
          const peerOpChains = {};
          const dataChannelHeartbeatTimers = {};
          const peerDisconnectGraceTimers = {};
          // Old clients already ignore _cc_keepalive frames; capability
          // negotiation never injects synthetic clipboard data.
          const P2P_DC_KEEPALIVE_JSON = JSON.stringify({
            _cc_keepalive: true, ackProtocol: 1,
          });
          const ackCapablePeers = new Set();
          const pendingAcknowledgements = {};
          const ACK_TIMEOUT_MS = 20000;
          const MAX_ACK_RETRIES = 2;
          const clearPeerAck = peerId => {
            const pending = pendingAcknowledgements[peerId];
            if (pending?.timer) clearTimeout(pending.timer);
            delete pendingAcknowledgements[peerId];
          };
          const clearAllAcks = () => {
            Object.keys(pendingAcknowledgements).forEach(clearPeerAck);
          };
          // Only the latest copy is retained in RAM when signaling is up but
          // the actual data channel is not ready. Never persist clipboard data.
          const PENDING_CLIPBOARD_TTL_MS = 90000;
          let pendingOutboundClipboard = null;

          const queueLatestClipboard = (content, type) => {
            if (typeof content !== 'string') return;
            // Limit pending memory: this is a short-lived clipboard, not history.
            if (content.length > 24 * 1024 * 1024) return;
            pendingOutboundClipboard = {content, type, savedAt: Date.now()};
          };

          const flushPendingClipboard = async () => {
            const pending = pendingOutboundClipboard;
            if (!pending) return;
            if (Date.now() - pending.savedAt > PENDING_CLIPBOARD_TTL_MS) {
              pendingOutboundClipboard = null;
              return;
            }
            if (!Object.values(dataChannels).some(ch => ch && ch.readyState === 'open')) return;
            pendingOutboundClipboard = null;
            // The function is assigned before a DataChannel opens; no reentrant
            // recursion when no peer is ready.
            await sendClipBoardP2P(pending.content, pending.type, true);
          };


          // Fragment variables
          let sendingFragmentId = '';
          let receivingFragments = {}; // Map: fragmentId -> array of strings (ordered)
          let sendingFragmentStats = null;
          let receivingFragmentStats = null;

          getP2PStatusMessage = async () => {
            let msg = '📊';
            msg += ` Peers: ${liveConnectionsCount}`;
            // Configuration status, not a claim that the selected ICE route
            // actually traverses TURN or that the last copy was delivered.
            const iceMode = await getDataFromAsyncStorage('p2pIceMode');
            msg += iceMode === 'turn-configured'
              ? ' | ICE: TURN available' : ' | ICE: direct/STUN only';
            if (sendingFragmentStats != null) {
              msg += ` | Sending: ${sendingFragmentStats}`;
            }
            if (receivingFragmentStats != null) {
              msg += ` | Receiving: ${receivingFragmentStats}`;
            }
            if (p2pMsg != null) {
              msg += ` | ${p2pMsg}`;
            }
            return msg;
          };

          const resetSendingFragmentId = async () => {
            sendingFragmentId = '';
            sendingFragmentStats = null;
            await resetP2PMsg();
          };

          const resetReceivingFragments = async () => {
            receivingFragments = {};
            receivingFragmentStats = null;
            await resetP2PMsg();
          };

          // Drop partial fragment buffers idle for FRAGMENT_TTL_MS so a peer
          // that disconnects mid-transfer can't leak memory forever.
          const pruneStaleReceivingFragments = () => {
            const now = Date.now();
            let pruned = 0;
            for (const fid of Object.keys(receivingFragments)) {
              const entry = receivingFragments[fid];
              if (entry && typeof entry.lastReceivedAt === 'number'
                  && (now - entry.lastReceivedAt) > FRAGMENT_TTL_MS) {
                delete receivingFragments[fid];
                pruned += 1;
              }
            }
            if (pruned > 0 && Object.keys(receivingFragments).length === 0) {
              receivingFragmentStats = null;
            }
          };

          const resetP2PMsg = async () => {
            p2pMsg = null;
            await p2pStatusMessageChanged();
          };

          const syncLiveConnectionsCount = async () => {
            liveConnectionsCount = Object.values(dataChannels).filter(
              c => c && c.readyState === 'open',
            ).length;
            isP2PStatusMsgChanged = true;
            await p2pStatusMessageChanged();
          };

          const runSerializedPeerOp = (peerId, op) => {
            const prev = peerOpChains[peerId] || Promise.resolve();
            const next = prev.then(() => op()).catch(() => {});
            peerOpChains[peerId] = next;
            return next;
          };

          const startDataChannelHeartbeat = (remotePeerId, channel) => {
            if (dataChannelHeartbeatTimers[remotePeerId]) {
              clearInterval(dataChannelHeartbeatTimers[remotePeerId]);
            }
            dataChannelHeartbeatTimers[remotePeerId] = setInterval(() => {
              try {
                if (channel.readyState === 'open') {
                  channel.send(P2P_DC_KEEPALIVE_JSON);
                }
              } catch (e) {
                // no-op
              }
            }, HEARTBEAT_INTERVAL);
          };

          async function cleanupPeerConnections() {
            p2pShuttingDown = true;
            clearAllAcks();
            ackCapablePeers.clear();
            try {
              for (const id of Object.keys(dataChannelHeartbeatTimers)) {
                clearInterval(dataChannelHeartbeatTimers[id]);
                delete dataChannelHeartbeatTimers[id];
              }
              for (const id of Object.keys(peerDisconnectGraceTimers)) {
                clearTimeout(peerDisconnectGraceTimers[id]);
                delete peerDisconnectGraceTimers[id];
              }
              for (const [, dc] of Object.entries(dataChannels)) {
                if (dc) {
                  try {
                    dc.onopen = null;
                    dc.onmessage = null;
                    dc.onclose = null;
                    dc.onerror = null;
                    dc.close();
                  } catch (e) {
                    // no-op
                  }
                }
              }
              dataChannels = {};

              for (const [, pc] of Object.entries(peerConnections)) {
                if (pc) {
                  try {
                    pc.onicecandidate = null;
                    pc.ondatachannel = null;
                    pc.onconnectionstatechange = null;
                    pc.oniceconnectionstatechange = null;
                    pc.close();
                  } catch (e) {
                    // no-op
                  }
                }
              }
              peerConnections = {};

              myPeerId = null;
              pendingPeerList = null;
              peers.clear();
              liveConnectionsCount = 0;
              for (const k of Object.keys(peerOpChains)) {
                delete peerOpChains[k];
              }
              await resetReceivingFragments();
              await resetSendingFragmentId();
            } finally {
              p2pShuttingDown = false;
            }
          }

          const initializeWebSocketSignalingClient = async () => {
            if (wsSignalingClient == null) {
              wsSignalingClient = new WebSocket(websocket_url);

              wsSignalingClient.onopen = async () => {
                await cleanupPeerConnections();

                await setDataInAsyncStorage('wsStatusMessage', '✅ Connected');

                if (enable_websocket_status_notification === 'true') {
                  if (websocket_status_notification_toggle == true) {
                    websocket_status_notification_toggle = false;
                    await showWebSocketStatusNotification(
                      'WebSocket Connection Restored 🔗',
                    );
                  } else {
                    await notifee.cancelNotification(
                      'ClipCascade_WebSocket_Status_Notification_Id',
                    );
                  }
                }
              };

              wsSignalingClient.onmessage = async event => {
                try {
                  const data = JSON.parse(event.data);
                  switch (data.type) {
                    case 'ASSIGNED_ID':
                      if (myPeerId && myPeerId !== data.peerId) {
                        await cleanupPeerConnections();
                      }
                      myPeerId = data.peerId;
                      if (pendingPeerList != null) {
                        const pending = pendingPeerList;
                        pendingPeerList = null;
                        await handlePeerList(pending);
                      }
                      break;

                    case 'PEER_LIST':
                      await handlePeerList(data.peers);
                      break;

                    case 'OFFER':
                      await handleOffer(data.fromPeerId, data.offer);
                      break;

                    case 'ANSWER':
                      await handleAnswer(data.fromPeerId, data.answer);
                      break;

                    case 'ICE_CANDIDATE':
                      await handleIceCandidate(data.fromPeerId, data.candidate);
                      break;
                  }

                  await setDataInAsyncStorage(
                    'wsStatusMessage',
                    '✅ Connected',
                  );
                } catch (e) {
                  await setDataInAsyncStorage(
                    'wsStatusMessage',
                    '❌ Inbound Error: ' + e,
                  );
                }
              };

              wsSignalingClient.onerror = async event => {
                await setDataInAsyncStorage(
                  'wsStatusMessage',
                  '❌ WebSocket Error: ' + JSON.stringify(event, null, 2),
                );
              };

              wsSignalingClient.onclose = async event => {
                const reason = event?.reason || 'closed by client';
                await setDataInAsyncStorage(
                  'wsStatusMessage',
                  '⚠️ WebSocket Close: ' + reason,
                );
                if (
                  enable_websocket_status_notification === 'true' &&
                  websocket_status_notification_toggle == false &&
                  (await getDataFromAsyncStorage('wsIsRunning')) === 'true'
                ) {
                  websocket_status_notification_toggle = true;
                  await showWebSocketStatusNotification(
                    'WebSocket Connection Lost ⛓️‍💥',
                    -1,
                  );
                }

                wsSignalingClient = null;
                setTimeout(async () => {
                  if (
                    wsSignalingClient == null &&
                    (await getDataFromAsyncStorage('wsIsRunning')) === 'true'
                  ) {
                    initializeWebSocketSignalingClient();
                  }
                }, RECONNECT_WS_TIMER);
              };
            }
          };

          // start websocket signaling connection
          initializeWebSocketSignalingClient();

          // send clipboard content P2P
          sendClipBoardP2P = async (clipContent, type_ = 'text', replay = false) => {
            const originalContent = clipContent;
            try {
              if (!replay) {
                // The most recent user copy supersedes a stale pending copy.
                pendingOutboundClipboard = null;
              }
              await clearFiles();
              if (
                (type_ === 'image' && enable_image_sharing === 'false') ||
                (type_ === 'files' && enable_file_sharing === 'false')
              ) return;

              if (!(await validateClipboardSize(clipContent, type_, 'Outbound'))) {
                return;
              }

              // Signaling may say Connected while WebRTC has no usable channel.
              // In that case keep the latest copy briefly; importantly, do not
              // update previous_clipboard_content_hash until it has been queued.
              let openChannels = Object.values(dataChannels).filter(
                ch => ch && ch.readyState === 'open',
              );
              if (openChannels.length === 0) {
                queueLatestClipboard(originalContent, type_);
                noteClipboardStage('p2p-' + type_ + '-pending');
                p2pMsg = '⏳ Clipboard pending: waiting for P2P data channel';
                await p2pStatusMessageChanged();
                return;
              }

              if (type_ === 'image') {
                clipContent = await NativeBridgeModule.getClipboardImageAsBase64(clipContent);
              } else if (type_ === 'files') {
                const temp = {};
                const filePaths = clipContent.split(',').filter(p => p.trim() !== '');
                for (const filePath of filePaths) {
                  temp[await NativeBridgeModule.getFileName(filePath)] =
                    await NativeBridgeModule.getFileAsBase64(filePath);
                }
                clipContent = JSON.stringify(temp);
              }

              const hcb = await hashCB(clipContent);
              if (!(await newCB(hcb))) return;

              const rawPayloadSizeInBytes = textEncoder.encode(clipContent).length;
              if (cipher_enabled === 'true') {
                clipContent = await encrypt(clipContent);
              }
              const fragments = await fragmentString(clipContent, FRAGMENT_SIZE);
              const metadata = {
                id: await generateUuid(),
                isFragmented: fragments.length > 1,
                index: 0,
                totalFragments: fragments.length,
                combinedRawPayloadSizeInBytes: rawPayloadSizeInBytes,
              };

              // A new *local* copy may replace the old outbound. Incoming
              // fragments must never cancel an unrelated outbound transfer.
              await resetSendingFragmentId();
              sendingFragmentId = metadata.id;
              const deadline = Date.now() + 120000;

              try {
                for (const fragment of fragments) {
                  if (sendingFragmentId !== metadata.id) return;

                  const messageJson = JSON.stringify({
                    payload: fragment,
                    type: type_,
                    metadata,
                  });
                  metadata.index += 1;

                  // Send to every live channel, not async forEach (which
                  // discards rejected promises and cannot enforce ordering).
                  openChannels = Object.values(dataChannels).filter(
                    ch => ch && ch.readyState === 'open',
                  );
                  if (openChannels.length === 0) {
                    queueLatestClipboard(originalContent, type_);
                    p2pMsg = '⏳ Clipboard pending: peer disconnected during send';
                    await p2pStatusMessageChanged();
                    return;
                  }
                  for (const channel of openChannels) {
                    while (typeof channel.bufferedAmount === 'number' &&
                      channel.bufferedAmount >= 256 * 1024) {
                      if (sendingFragmentId !== metadata.id ||
                          channel.readyState !== 'open') {
                        queueLatestClipboard(originalContent, type_);
                        return;
                      }
                      if (Date.now() >= deadline) {
                        throw new Error('P2P DataChannel buffer did not drain');
                      }
                      await sleep(20);
                    }
                    if (channel.readyState !== 'open') {
                      queueLatestClipboard(originalContent, type_);
                      return;
                    }
                    await channel.send(messageJson);
                  }
                  if (metadata.isFragmented) {
                    sendingFragmentStats = `${metadata.index}/${metadata.totalFragments}`;
                    await p2pStatusMessageChanged();
                  }
                }
                // DataChannel.send only queues chunks: this does NOT imply
                // application-level acknowledgement by the receiving device.
                previous_clipboard_content_hash = hcb;
                noteClipboardStage('p2p-' + type_ + '-queued');
              } finally {
                if (sendingFragmentId === metadata.id) {
                  await resetSendingFragmentId();
                }
              }
            } catch (e) {
              queueLatestClipboard(originalContent, type_);
              noteClipboardStage('p2p-' + type_ + '-error');
              p2pMsg = '❌ P2P Outbound Error: ' + String(e?.message || e);
              await p2pStatusMessageChanged();
            }
          };

          // stop events and connection P2P
          stopServicesP2P = async () => {
            pendingOutboundClipboard = null;
            // 1) Stop listening to clipboard events
            try {
              await ClipboardListener.stopListening();
              if (clipboardOnChange) {
                clipboardOnChange.remove();
              }
            } catch (e) {
              // no-op
            }

            // 2) Clean up the WebSocket (signaling client)
            if (wsSignalingClient) {
              // Remove all listeners so it won't re-fire or reconnect
              wsSignalingClient.onopen = null;
              wsSignalingClient.onmessage = null;
              wsSignalingClient.onerror = null;
              wsSignalingClient.onclose = null;

              // Close it
              try {
                wsSignalingClient.close();
              } catch (e) {
                // no-op
              }
            }
            wsSignalingClient = null;

            // 3) Close all DataChannels and RTCPeerConnections
            await cleanupPeerConnections();

            // 4) Finally, stop the foreground service
            await setDataInAsyncStorage('wsStatusMessage', '✅ Disconnected');
            await setDataInAsyncStorage('p2pStatusMessage', '');
            cleanupClipboardListeners();
            await notifee.stopForegroundService();
          };

          // send message to websocket signaling server
          const signalingSend = async obj => {
            try {
              if (
                wsSignalingClient &&
                wsSignalingClient.readyState === WebSocket.OPEN
              ) {
                wsSignalingClient.send(JSON.stringify(obj));
                await setDataInAsyncStorage('wsStatusMessage', '✅ Connected');
              }
            } catch (e) {
              await setDataInAsyncStorage(
                'wsStatusMessage',
                '❌ Outbound Error: ' + e,
              );
            }
          };

          // receive clipboard content P2P
          const onDataChannelMessage = async (messageJson, remotePeerId = null, channel = null) => {
            try {
              const message = JSON.parse(messageJson);
              if (message && message._cc_keepalive === true) {
                if (message.ackProtocol === 1 && remotePeerId) {
                  ackCapablePeers.add(remotePeerId);
                }
                return;
              }
              if (message && typeof message._cc_ack === 'string') {
                const pending = pendingAcknowledgements[remotePeerId];
                if (pending && pending.id === message._cc_ack) {
                  clearPeerAck(remotePeerId);
                  noteClipboardStage('p2p-' + pending.type + '-acknowledged');
                }
                return;
              }

              await clearFiles(true);
              // Incoming transfer must not cancel an unrelated outbound
              // clipboard operation (simultaneous bidirectional copying).
              let cb = String(message.payload);
              const type_ = message.type ?? 'text';
              const metadata = message.metadata;

              // Check if the payload exceeds the maximum size: first layer protection
              if (
                metadata != null &&
                max_clipboard_size_local_limit_bytes >= 0 &&
                metadata.combinedRawPayloadSizeInBytes >
                  max_clipboard_size_local_limit_bytes
              ) {
                await resetReceivingFragments();
                p2pMsg = `⚠️ Payload size limit exceeded: ${metadata['combinedRawPayloadSizeInBytes']} bytes exceeds ${max_clipboard_size_local_limit_bytes} bytes`;
                await p2pStatusMessageChanged();
                return;
              }

              // Fragmented message handling
              if (metadata != null && metadata.isFragmented) {
                pruneStaleReceivingFragments();
                receivingFragmentStats = `${metadata.index + 1}/${
                  metadata.totalFragments
                }`;
                await p2pStatusMessageChanged();

                if (metadata.id in receivingFragments) {
                  const entry = receivingFragments[metadata.id];
                  entry.fragments[metadata.index] = cb;
                  entry.lastReceivedAt = Date.now();

                  // If this is the last fragment, try to combine
                  if (metadata.index === metadata.totalFragments - 1) {
                    // Check if all fragments are present (none is empty)
                    if (entry.fragments.every(frag => frag !== '')) {
                      // Join them all together into one payload
                      cb = entry.fragments.join('');
                      delete receivingFragments[metadata.id];
                    } else {
                      // Missing fragment(s): error out
                      await resetReceivingFragments();
                      p2pMsg =
                        'Failed to receive: One or more fragments are missing or the clipboard changed before completion.';
                      await p2pStatusMessageChanged();
                      return;
                    }
                  } else {
                    // Not the last fragment, so we don't proceed further
                    return;
                  }
                } else {
                  await resetReceivingFragments();
                  receivingFragments[metadata.id] = {
                    lastReceivedAt: Date.now(),
                    fragments: Array(metadata.totalFragments).fill(''),
                  };
                  receivingFragments[metadata.id].fragments[metadata.index] = cb;
                  return;
                }
              }

              await clearFiles();

              // decrypt
              if (cipher_enabled === 'true') {
                try {
                  cb = await decrypt(JSON.parse(cb));
                } catch (error) {
                  throw new Error(
                    `Encryption must be enabled on all devices if enabled. JSON parsing failed: ${error.message}`,
                  );
                }
              }

              // hash clipboard content
              const hcb = await hashCB(cb);
              let accepted = false;
              if (await newCB(hcb)) {
                // A rejected/failed clipboard write must not be acknowledged.
                if (await validateClipboardSize(cb, type_, 'Inbound')) {
                  if (type_ === 'text') {
                    await Clipboard.setString(cb);
                  } else if (type_ === 'image') {
                    await NativeBridgeModule.copyBase64ImageToClipboardUsingCache(cb);
                  } else if (type_ === 'files') {
                    await showFilesDownloadNotification('📥 Download File(s)');
                    files_in_memory = cb;
                    await setDataInAsyncStorage('filesAvailableToDownload', 'true');
                  } else {
                    return;
                  }
                  previous_clipboard_content_hash = hcb;
                  accepted = true;
                }
              } else {
                // Repeated frame after a lost ACK. Clipboard already contains
                // this content; acknowledge without applying it twice.
                accepted = true;
              }
              if (accepted && metadata?.id && remotePeerId &&
                  ackCapablePeers.has(remotePeerId) &&
                  channel?.readyState === 'open') {
                channel.send(JSON.stringify({_cc_ack: metadata.id}));
              }
            } catch (e) {
              p2pMsg = '❌ P2P Inbound Error: ' + e;
              await p2pStatusMessageChanged();
            }
          };

          /**
           * The server gave us the entire list of peers in the "room".
           * For each peer, create a PeerConnection if we don't have one yet.
           */
          const handlePeerList = async peerList => {
            if (!myPeerId) {
              pendingPeerList = Array.isArray(peerList) ? [...peerList] : [];
              return;
            }
            const updatedPeers = new Set(peerList);
            peers = updatedPeers;
            await removeStalePeers(updatedPeers);

            // Await each peer setup and serialize it with recovery/OFFER handling.
            // An async forEach can race repeated PEER_LIST messages during VPN
            // reconnect: both see an absent PC before ICE credential fetch.
            for (const pid of updatedPeers) {
              if (pid === myPeerId) continue;
              await runSerializedPeerOp(pid, async () => {
                if (p2pShuttingDown || !myPeerId || !peers.has(pid) ||
                    peerConnections[pid]) return;
                const pc = await createPeerConnection(pid);
                if (p2pShuttingDown || !peers.has(pid)) {
                  pc.close();
                  return;
                }
                peerConnections[pid] = pc;
                if (myPeerId < pid) {
                  const channel = await pc.createDataChannel('cliptext');
                  dataChannels[pid] = channel;
                  await setupDataChannel(pid, channel);
                  await createOffer(pid);
                }
              });
            }
          };

          /**
           * Close connections and data channels for peers that no longer exist in PEER_LIST.
           */
          const removeStalePeers = async updatedPeers => {
            // 1) Find which peer IDs are no longer present
            const stalePeerIds = Object.keys(peerConnections).filter(
              pid => !updatedPeers.has(pid),
            );
            // 2) For each stale peer, close data channel and peer connection
            for (const oldPid of stalePeerIds) {
              delete peerOpChains[oldPid];
              clearPeerAck(oldPid);
              ackCapablePeers.delete(oldPid);
              if (peerDisconnectGraceTimers[oldPid]) {
                clearTimeout(peerDisconnectGraceTimers[oldPid]);
                delete peerDisconnectGraceTimers[oldPid];
              }
              if (dataChannelHeartbeatTimers[oldPid]) {
                clearInterval(dataChannelHeartbeatTimers[oldPid]);
                delete dataChannelHeartbeatTimers[oldPid];
              }
              if (dataChannels[oldPid]) {
                try {
                  dataChannels[oldPid].onopen = null;
                  dataChannels[oldPid].onmessage = null;
                  dataChannels[oldPid].onclose = null;
                  dataChannels[oldPid].onerror = null;
                  dataChannels[oldPid].close();
                } catch (err) {}
                delete dataChannels[oldPid];
              }

              if (peerConnections[oldPid]) {
                try {
                  peerConnections[oldPid].onicecandidate = null;
                  peerConnections[oldPid].ondatachannel = null;
                  peerConnections[oldPid].onconnectionstatechange = null;
                  peerConnections[oldPid].close();
                } catch (err) {}
                delete peerConnections[oldPid];
              }
            }
            await syncLiveConnectionsCount();
          };

          const disposePeerConnection = async peerId => {
            clearPeerAck(peerId);
            ackCapablePeers.delete(peerId);
            if (peerDisconnectGraceTimers[peerId]) {
              clearTimeout(peerDisconnectGraceTimers[peerId]);
              delete peerDisconnectGraceTimers[peerId];
            }
            if (dataChannelHeartbeatTimers[peerId]) {
              clearInterval(dataChannelHeartbeatTimers[peerId]);
              delete dataChannelHeartbeatTimers[peerId];
            }
            const dc = dataChannels[peerId];
            if (dc) {
              try {
                dc.onopen = null;
                dc.onmessage = null;
                dc.onclose = null;
                dc.onerror = null;
                dc.close();
              } catch (e) {
                // no-op
              }
              delete dataChannels[peerId];
            }
            const pc = peerConnections[peerId];
            if (pc) {
              try {
                pc.onicecandidate = null;
                pc.ondatachannel = null;
                pc.onconnectionstatechange = null;
                    pc.oniceconnectionstatechange = null;
                pc.close();
              } catch (e) {
                // no-op
              }
              delete peerConnections[peerId];
            }
            await syncLiveConnectionsCount();
          };

          /**
           * Create and return a RTCPeerConnection, set up listeners for ICE + DataChannel.
           */
          const createPeerConnection = async remotePeerId => {
            // Fetch short-lived, session-authenticated TURN credentials before
            // each new connection; the helper caches them only in RAM. When the
            // issuer is not configured, ordinary STUN P2P remains available.
            const endpoint = await getDataFromAsyncStorage('server_url');
            const ice = await loadIceServerConfig(endpoint, stun_url);
            await setDataInAsyncStorage('p2pIceMode',
              ice.hasTurn ? 'turn-configured' : 'direct-only');
            const pc = new RTCPeerConnection({iceServers: ice.servers});

            pc.onicecandidate = async event => {
              if (event.candidate) {
                await signalingSend({
                  type: 'ICE_CANDIDATE',
                  fromPeerId: myPeerId,
                  toPeerId: remotePeerId,
                  candidate: event.candidate,
                });
              }
            };

            pc.ondatachannel = async event => {
              const channel = event.channel;
              dataChannels[remotePeerId] = channel;
              await setupDataChannel(remotePeerId, channel);
            };

            const checkPeerConnectivity = () => {
              const st = pc.connectionState;
              const ice = pc.iceConnectionState;
              // Some Android VPN/network transitions first surface in ICE
              // state, before RTCPeerConnection.connectionState updates.
              if ((st === 'disconnected' || ice === 'disconnected') &&
                  !peerDisconnectGraceTimers[remotePeerId]) {
                // A VPN/network switch may keep ICE 'disconnected' without
                // closing WebSocket. Allow transient routing changes to heal.
                peerDisconnectGraceTimers[remotePeerId] = setTimeout(() => {
                  delete peerDisconnectGraceTimers[remotePeerId];
                  if (!p2pShuttingDown &&
                      peerConnections[remotePeerId] === pc &&
                      (pc.connectionState === 'disconnected' ||
                       pc.iceConnectionState === 'disconnected')) {
                    recoverPeerTransport(remotePeerId, pc);
                  }
                }, 15000);
              } else if (st !== 'disconnected' && ice !== 'disconnected') {
                if (peerDisconnectGraceTimers[remotePeerId]) {
                  clearTimeout(peerDisconnectGraceTimers[remotePeerId]);
                  delete peerDisconnectGraceTimers[remotePeerId];
                }
              }
              if (st === 'failed' || st === 'closed' || ice === 'failed') {
                recoverPeerTransport(remotePeerId, pc);
              }
            };
            pc.onconnectionstatechange = checkPeerConnectivity;
            pc.oniceconnectionstatechange = checkPeerConnectivity;

            return pc;
          };

          /**
           * Create an SDP offer for remotePeerId and send via signaling.
           */
          const createOffer = async remotePeerId => {
            const pc = peerConnections[remotePeerId];
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);

            await signalingSend({
              type: 'OFFER',
              fromPeerId: myPeerId,
              toPeerId: remotePeerId,
              offer: pc.localDescription,
            });
          };

          const recoverPeerTransport = async (remotePeerId, deadPc) => {
            if (p2pShuttingDown || !myPeerId || !peers.has(remotePeerId)) {
              return;
            }
            if (deadPc != null && peerConnections[remotePeerId] !== deadPc) {
              return;
            }
            await runSerializedPeerOp(remotePeerId, async () => {
              if (p2pShuttingDown || !myPeerId || !peers.has(remotePeerId)) {
                return;
              }
              if (deadPc != null && peerConnections[remotePeerId] !== deadPc) {
                return;
              }
              if (deadPc == null) {
                const ch = dataChannels[remotePeerId];
                if (ch && ch.readyState === 'open') {
                  return;
                }
              }
              await disposePeerConnection(remotePeerId);
              if (p2pShuttingDown || !myPeerId || !peers.has(remotePeerId)) {
                return;
              }
              const newPc = await createPeerConnection(remotePeerId);
              peerConnections[remotePeerId] = newPc;
              if (myPeerId < remotePeerId) {
                const channel = await newPc.createDataChannel('cliptext');
                dataChannels[remotePeerId] = channel;
                await setupDataChannel(remotePeerId, channel);
                await createOffer(remotePeerId);
              }
            });
          };

          /**
           * Handle incoming OFFER from remote, then respond with ANSWER.
           */
          const handleOffer = async (fromPeerId, offer) => {
            if (p2pShuttingDown) {
              return;
            }
            // Ignore delayed/stale OFFERs for peers removed from the latest PEER_LIST.
            // Startup guard: allow early signaling before ASSIGNED_ID/PEER_LIST is ready.
            if (myPeerId && peers.size > 0 && !peers.has(fromPeerId)) {
              return;
            }
            await runSerializedPeerOp(fromPeerId, async () => {
              if (p2pShuttingDown) {
                return;
              }
              // TOCTOU guard: PEER_LIST can change after the outer fast-path check.
              if (myPeerId && peers.size > 0 && !peers.has(fromPeerId)) {
                return;
              }
              // Full new offer (e.g. after peer recovery): must not apply on an
              // existing connected PC or datachannel counts diverge across devices.
              if (peerConnections[fromPeerId]) {
                await disposePeerConnection(fromPeerId);
              }
              const pc = await createPeerConnection(fromPeerId);
              peerConnections[fromPeerId] = pc;

              await pc.setRemoteDescription(new RTCSessionDescription(offer));
              const answer = await pc.createAnswer();
              await pc.setLocalDescription(answer);

              await signalingSend({
                type: 'ANSWER',
                fromPeerId: myPeerId,
                toPeerId: fromPeerId,
                answer: pc.localDescription,
              });
            });
          };

          /**
           * Handle incoming ANSWER from remote to our previously sent OFFER.
           */
          const handleAnswer = async (fromPeerId, answer) => {
            const pc = peerConnections[fromPeerId];
            if (!pc) {
              return;
            }
            if (
              pc.connectionState === 'failed' ||
              pc.connectionState === 'closed'
            ) {
              return;
            }

            await pc.setRemoteDescription(new RTCSessionDescription(answer));
          };

          /**
           * Handle incoming ICE candidate from remote peer.
           */
          const handleIceCandidate = async (fromPeerId, candidateData) => {
            const pc = peerConnections[fromPeerId];
            if (!pc) {
              return;
            }
            if (
              pc.connectionState === 'failed' ||
              pc.connectionState === 'closed'
            ) {
              return;
            }

            await pc.addIceCandidate(new RTCIceCandidate(candidateData));
          };

          /**
           * Set up DataChannel for remotePeerId.
           */
          const setupDataChannel = async (remotePeerId, channel) => {
            channel.onopen = async () => {
              startDataChannelHeartbeat(remotePeerId, channel);
              // Immediate capability advertisement, backwards compatible.
              channel.send(P2P_DC_KEEPALIVE_JSON);
              await syncLiveConnectionsCount();
              await flushPendingClipboard();
            };

            channel.onmessage = async e => {
              await onDataChannelMessage(e.data, remotePeerId, channel);
            };

            channel.onclose = async () => {
              if (dataChannelHeartbeatTimers[remotePeerId]) {
                clearInterval(dataChannelHeartbeatTimers[remotePeerId]);
                delete dataChannelHeartbeatTimers[remotePeerId];
              }
              await syncLiveConnectionsCount();
              await recoverPeerTransport(remotePeerId, null);
            };

            channel.onerror = async err => {
              p2pMsg = '❌ DataChannel error with ' + remotePeerId + ': ' + err;
              await p2pStatusMessageChanged();
            };

            if (channel.readyState === 'open') {
              startDataChannelHeartbeat(remotePeerId, channel);
              await syncLiveConnectionsCount();
              await flushPendingClipboard();
            }
          };
        }

        // send clipboard content
        const sendClipBoard = async (clipContent, type_ = 'text') => {
          if (server_mode === 'P2S') {
            await sendClipBoardP2S(clipContent, type_);
          } else if (server_mode === 'P2P') {
            await sendClipBoardP2P(clipContent, type_);
          }
        };

        // Start only AFTER sendClipBoard exists: MediaStore callbacks must never
        // observe an uninitialized JS transport during startup.
        // Old gallery content is never emitted; native observer takes a baseline.
        if ((await getDataFromAsyncStorage('auto_sync_screenshots')) === 'true') {
          try {
            await ClipboardListener.startScreenshotMonitoring();
          } catch (_) {
            await setDataInAsyncStorage(
              'wsStatusMessage',
              '⚠️ Screenshot auto-sync requires full photo permission.',
            );
          }
        }

        // terminate service when wsIsRunning is false
        const stopServices = async () => {
          if (server_mode === 'P2S') {
            await stopServicesP2S();
          } else if (server_mode === 'P2P') {
            await stopServicesP2P();
          }

          cleanupClipboardListeners();
        };

        function sleep(ms) {
          return new Promise(res => setTimeout(res, ms));
        }

        async function pollFlagsLoop() {
          const POLL_KEYS = [
            'wsIsRunning',
            'echo',
            'downloadFiles',
            'filesAvailableToDownload',
          ];

          while (true) {
            const json = NativeBridgeModule.getFlagsSync(POLL_KEYS);
            const latest = JSON.parse(json);

            // check if wsIsRunning is true or else terminate the service
            if (latest.wsIsRunning !== 'true') {
              await stopServices();
              await setDataInAsyncStorage(
                'wsForegroundServiceTerminated',
                'true',
              );
              break;
            }

            // The shared checker gates requests to once a day and deduplicates
            // concurrent screen/service checks. Never delay clipboard polling.
            checkForUpdates();

            if (isP2PStatusMsgChanged) {
              isP2PStatusMsgChanged = false;
              await setDataInAsyncStorage(
                'p2pStatusMessage',
                await getP2PStatusMessage(),
              );
            }

            // check if ping initiated
            if (latest.echo === 'ping') {
              await setDataInAsyncStorage('echo', 'pong');
            }

            // check if user wants to download files
            if (
              latest.downloadFiles === 'true' &&
              latest.filesAvailableToDownload === 'true'
            ) {
              try {
                await setDataInAsyncStorage('downloadFiles', 'false');
                const dirPath = await getDataFromAsyncStorage('dirPath');

                // display progress notification
                await notifee.displayNotification({
                  id: 'ClipCascade_Download_Files_Progress_Notification_Id',
                  title: 'Downloading File(s)...',
                  android: {
                    channelId: 'ClipCascade_Progress',
                    smallIcon: 'ic_small_icon',
                    progress: {
                      indeterminate: true,
                    },
                  },
                });

                if (files_in_memory != null) {
                  // save files
                  await NativeBridgeModule.saveBase64Files(
                    dirPath,
                    files_in_memory,
                  );
                }
              } catch (e) {
                // Alert is displayed only when the app is open because this is called from foreground service
                Alert.alert('Error', 'Failed to download files: ' + e);
              } finally {
                await notifee.cancelNotification(
                  'ClipCascade_Download_Files_Progress_Notification_Id',
                );
              }
            }
            await sleep(1000);
          }
        }

        pollFlagsLoop();
      } catch (error) {
        await setDataInAsyncStorage('wsStatusMessage', '❌ Error:' + error);
        cleanupClipboardListeners();
        await notifee.stopForegroundService();
      }
    });
  });

  try {
    // Create a notification channel for the foreground service
    const channelId = await notifee.createChannel({
      id: 'ClipCascade',
      name: 'ClipCascade Monitor',
      importance: AndroidImportance.LOW,
      sound: '',
    });

    // Display a notification to start the foreground service
    await notifee.displayNotification({
      title: 'ClipCascade',
      android: {
        channelId,
        asForegroundService: true,
        smallIcon: 'ic_small_icon',
        color: 'gray',
        pressAction: {
          id: 'default',
          launchActivity: 'default',
        },
      },
    });

    // Create a notification channel for download progress
    await notifee.createChannel({
      id: 'ClipCascade_Progress',
      name: 'ClipCascade Download Progress',
      importance: AndroidImportance.DEFAULT,
    });

    // Create a notification channel for connection status
    await notifee.createChannel({
      id: 'ClipCascade_Connection_Status',
      name: 'ClipCascade Connection Status',
      importance: AndroidImportance.HIGH,
    });

    return [true, 'Foreground service is running'];
  } catch (error) {
    return [false, error];
  }
};
