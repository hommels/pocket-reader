/**
 * Pocket Reader - Background Service Worker
 * Coordinates between popup and content scripts
 * Handles keyboard shortcuts
 * Proxies TTS API requests to bypass page CSP restrictions
 */

const SERVER_URL = 'http://localhost:5050';

// State tracking
let activeTabId = null;

/**
 * Handle TTS API proxy requests from content scripts
 * This bypasses page CSP restrictions since background scripts have host_permissions
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'synthesize') {
    // Proxy synthesize request to TTS server
    (async () => {
      try {
        const response = await fetch(`${SERVER_URL}/synthesize`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: message.text, voice: message.voice }),
        });

        if (!response.ok) {
          const error = await response.json();
          sendResponse({ error: error.error || 'Server error' });
          return;
        }

        const contentType = response.headers.get('content-type') || 'audio/wav';
        const blob = await response.blob();
        const arrayBuffer = await blob.arrayBuffer();

        sendResponse({ audioData: Array.from(new Uint8Array(arrayBuffer)), contentType });
      } catch (error) {
        sendResponse({ error: error.message || 'Network error' });
      }
    })();
    return true; // Keep channel open for async response
  }

  if (message.action === 'getParagraphs') {
    // Proxy paragraphs request to TTS server
    (async () => {
      try {
        const response = await fetch(`${SERVER_URL}/paragraphs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: message.text }),
        });

        if (!response.ok) {
          sendResponse({ error: 'Failed to split text into paragraphs' });
          return;
        }

        const data = await response.json();
        sendResponse({ paragraphs: data.paragraphs });
      } catch (error) {
        sendResponse({ error: error.message || 'Network error' });
      }
    })();
    return true; // Keep channel open for async response
  }
});

// Create context menus on extension install/update
chrome.runtime.onInstalled.addListener(() => {
  // Menu item for selected text
  chrome.contextMenus.create({
    id: 'read-selection',
    title: 'Read selected text',
    contexts: ['selection']
  });

  // Menu item for reading from cursor position
  chrome.contextMenus.create({
    id: 'read-from-here',
    title: 'Read from here',
    contexts: ['page']
  });
});

/**
 * Forward stop command to the active tab's content script
 */
function stopPlayback() {
  if (activeTabId) {
    chrome.tabs.sendMessage(activeTabId, { action: 'stop' }).catch(() => {
      // Tab might be closed, ignore
    });
  }
}

/**
 * Handle context menu clicks
 */
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  // Get saved voice and speed preferences
  const { voice = 'alba', speed = 1.0 } = await chrome.storage.local.get(['voice', 'speed']);

  if (info.menuItemId === 'read-selection') {
    // Read selected text
    const selectedText = info.selectionText;

    if (!selectedText || selectedText.trim().length === 0) {
      return;
    }

    // Stop any current playback first
    await chrome.tabs.sendMessage(tab.id, { action: 'stop' }).catch(() => { });

    // Small delay to ensure stop completes
    await new Promise(resolve => setTimeout(resolve, 100));

    // Read the selected text
    chrome.tabs.sendMessage(tab.id, {
      action: 'readText',
      text: selectedText,
      voice: voice,
      speed: speed,
      fromContextMenu: true
    });

  } else if (info.menuItemId === 'read-from-here') {
    // Stop any current playback first
    await chrome.tabs.sendMessage(tab.id, { action: 'stop' }).catch(() => { });

    // Small delay to ensure stop completes
    await new Promise(resolve => setTimeout(resolve, 100));

    // Scan and read from current page position
    // The content script will figure out where to start based on scroll position
    chrome.tabs.sendMessage(tab.id, {
      action: 'readFromHere',
      voice: voice,
      speed: speed
    });
  }
});

/**
 * Handle keyboard commands
 */
chrome.commands.onCommand.addListener(async (command) => {
  // Get the active tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  if (command === 'toggle-playback') {
    // First check if we're currently playing
    try {
      const state = await new Promise((resolve) => {
        chrome.tabs.sendMessage(tab.id, { action: 'getPlaybackState' }, (response) => {
          if (chrome.runtime.lastError) {
            resolve(null);
          } else {
            resolve(response);
          }
        });
      });

      if (state && state.isPlaying) {
        // Currently playing, pause it
        chrome.tabs.sendMessage(tab.id, { action: 'pause' });
      } else if (state && state.isPaused) {
        // Currently paused, resume it
        chrome.tabs.sendMessage(tab.id, { action: 'resume' });
      } else {
        // Not playing, start reading
        await startReadingFromShortcut(tab);
      }
    } catch (error) {
      console.error('Error handling toggle-playback:', error);
    }
  } else if (command === 'stop-playback') {
    chrome.tabs.sendMessage(tab.id, { action: 'stop' }).catch(() => {});
    activeTabId = null;
  }
});

/**
 * Start reading the current page from a keyboard shortcut
 */
async function startReadingFromShortcut(tab) {
  try {
    // Ensure content script is loaded
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js']
      });
    } catch (e) {
      // Script might already be loaded
    }

    // Scan for readable elements (with DOM references for highlighting)
    const response = await new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tab.id, { action: 'scanElements' }, (resp) => {
        if (chrome.runtime.lastError) {
          reject(new Error('Could not access page'));
        } else {
          resolve(resp);
        }
      });
    });

    if (!response || !response.success || !response.paragraphs) {
      console.error('Could not scan page content');
      return;
    }

    const paragraphs = response.paragraphs;

    // Get saved preferences
    const { voice, speed } = await chrome.storage.local.get(['voice', 'speed']);

    // Check for saved position
    const savedPosition = await new Promise((resolve) => {
      chrome.tabs.sendMessage(tab.id, { action: 'getSavedPosition' }, (resp) => {
        if (chrome.runtime.lastError) {
          resolve(null);
        } else {
          resolve(resp);
        }
      });
    });

    const startIndex = (savedPosition && savedPosition.index > 0 && savedPosition.index < paragraphs.length) 
      ? savedPosition.index 
      : 0;

    // Start reading with highlighting enabled
    activeTabId = tab.id;
    chrome.tabs.sendMessage(tab.id, {
      action: 'readParagraphs',
      paragraphs: paragraphs,
      startIndex: startIndex,
      voice: voice || 'alba',
      speed: speed || 1.0
    });

  } catch (error) {
    console.error('Error starting reading from shortcut:', error);
  }
}

/**
 * Handle messages from popup
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // If message is from content script, forward to popup
  if (sender.tab) {
    // Message from content script - forward to popup
    // The popup listens directly via chrome.runtime.onMessage
    return;
  }

  // Message from popup
  switch (message.action) {
    case 'startReading':
      activeTabId = message.tabId;
      // Forward to content script
      chrome.tabs.sendMessage(message.tabId, {
        action: 'readText',
        text: message.text,
        voice: message.voice,
      }).catch((error) => {
        console.error('Error sending to content script:', error);
      });
      sendResponse({ status: 'started' });
      break;

    case 'stop':
      stopPlayback();
      sendResponse({ status: 'stopped' });
      break;
  }

  return true;
});

// Log service worker start
console.log('Pocket Reader background service worker started');
