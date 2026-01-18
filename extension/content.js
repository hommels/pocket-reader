/**
 * Pocket Reader - Content Script
 * Extracts main content from web pages and handles audio playback
 * Uses prefetching to generate next paragraph while current one plays
 * TTS API requests are proxied through the background script to bypass page CSP
 */

// Audio playback state
let currentAudio = null;
let shouldStop = false;
let isPaused = false;
let isInPlaybackSession = false; // Track if we're in an active reading session
let playbackSpeed = 1.0;
let currentParagraphIndex = 0;
let totalParagraphs = 0;
let pendingAudioUrls = []; // Track URLs to clean up on stop

// Pending playback state for autoplay policy retry
let pendingPlayback = null; // { audioBlob, onReadyToPrefetch, resolve, reject }
let playOverlayElement = null;

// Pre-create Audio element to avoid autoplay policy issues
// This element will be reused for all playback
function ensureAudioElement() {
  if (!currentAudio) {
    currentAudio = new Audio();
    // Don't pre-set a source - just create the element
    // Setting a source here can trigger errors when switching sources later
  }
  return currentAudio;
}

/**
 * Clear audio element event handlers to prevent stale callbacks
 */
function clearAudioHandlers() {
  if (currentAudio) {
    currentAudio.onended = null;
    currentAudio.onerror = null;
    currentAudio.ontimeupdate = null;
  }
}

// DOM element tracking for highlighting
let readableElements = []; // Array of DOM elements that can be read
let currentHighlightedElement = null;
let paragraphControlButton = null; // Pause/play button on highlighted paragraph

// CSS class for highlighting
const HIGHLIGHT_CLASS = 'pocket-reader-highlight';
const HIGHLIGHT_STYLE_ID = 'pocket-reader-styles';
const PLAY_OVERLAY_ID = 'pocket-reader-play-overlay';
const PARAGRAPH_CONTROL_ID = 'pocket-reader-paragraph-control';

/**
 * Inject highlight styles into the page
 */
function injectHighlightStyles() {
  if (document.getElementById(HIGHLIGHT_STYLE_ID)) return;

  const style = document.createElement('style');
  style.id = HIGHLIGHT_STYLE_ID;
  style.textContent = `
    .${HIGHLIGHT_CLASS} {
      background-color: rgba(99, 102, 241, 0.15) !important;
      outline: 2px solid rgba(99, 102, 241, 0.5) !important;
      outline-offset: 2px !important;
      border-radius: 4px !important;
      transition: background-color 0.2s ease, outline 0.2s ease !important;
      position: relative !important;
    }
    #${PARAGRAPH_CONTROL_ID} {
      position: absolute !important;
      top: -12px !important;
      right: -12px !important;
      width: 28px !important;
      height: 28px !important;
      border-radius: 50% !important;
      background: linear-gradient(135deg, #6366f1 0%, #4f46e5 100%) !important;
      border: 2px solid white !important;
      box-shadow: 0 2px 8px rgba(99, 102, 241, 0.4), 0 1px 3px rgba(0, 0, 0, 0.15) !important;
      cursor: pointer !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      z-index: 2147483647 !important;
      transition: transform 0.15s ease, box-shadow 0.15s ease !important;
      padding: 0 !important;
    }
    #${PARAGRAPH_CONTROL_ID}:hover {
      transform: scale(1.1) !important;
      box-shadow: 0 4px 12px rgba(99, 102, 241, 0.5), 0 2px 4px rgba(0, 0, 0, 0.2) !important;
    }
    #${PARAGRAPH_CONTROL_ID}:active {
      transform: scale(0.95) !important;
    }
    #${PARAGRAPH_CONTROL_ID} svg {
      width: 14px !important;
      height: 14px !important;
      fill: white !important;
    }
    #${PLAY_OVERLAY_ID} {
      position: fixed !important;
      top: 50% !important;
      left: 50% !important;
      transform: translate(-50%, -50%) !important;
      z-index: 2147483647 !important;
      background: linear-gradient(135deg, #6366f1 0%, #4f46e5 100%) !important;
      color: white !important;
      border: none !important;
      border-radius: 16px !important;
      padding: 20px 32px !important;
      font-size: 18px !important;
      font-weight: 600 !important;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif !important;
      cursor: pointer !important;
      box-shadow: 0 8px 32px rgba(99, 102, 241, 0.4), 0 4px 12px rgba(0, 0, 0, 0.15) !important;
      display: flex !important;
      align-items: center !important;
      gap: 12px !important;
      transition: transform 0.2s ease, box-shadow 0.2s ease !important;
    }
    #${PLAY_OVERLAY_ID}:hover {
      transform: translate(-50%, -50%) scale(1.05) !important;
      box-shadow: 0 12px 40px rgba(99, 102, 241, 0.5), 0 6px 16px rgba(0, 0, 0, 0.2) !important;
    }
    #${PLAY_OVERLAY_ID}:active {
      transform: translate(-50%, -50%) scale(0.98) !important;
    }
    #${PLAY_OVERLAY_ID} svg {
      width: 24px !important;
      height: 24px !important;
      fill: currentColor !important;
    }
    #pocket-reader-overlay-backdrop {
      position: fixed !important;
      top: 0 !important;
      left: 0 !important;
      width: 100vw !important;
      height: 100vh !important;
      background: rgba(0, 0, 0, 0.3) !important;
      z-index: 2147483646 !important;
    }
  `;
  document.head.appendChild(style);
}

/**
 * Highlight a specific element
 */
function highlightElement(element) {
  // Remove previous highlight and control button
  if (currentHighlightedElement) {
    currentHighlightedElement.classList.remove(HIGHLIGHT_CLASS);
    removeParagraphControl();
  }
  
  if (element) {
    // Ensure element has position for absolute positioning of control button
    const computedStyle = window.getComputedStyle(element);
    if (computedStyle.position === 'static') {
      element.style.position = 'relative';
    }
    
    element.classList.add(HIGHLIGHT_CLASS);
    currentHighlightedElement = element;
    
    // Add pause/play control button
    showParagraphControl(element);
    
    // Scroll element into view smoothly
    element.scrollIntoView({
      behavior: 'smooth',
      block: 'center',
      inline: 'nearest'
    });
  }
}

/**
 * Remove all highlights
 */
function removeHighlight() {
  if (currentHighlightedElement) {
    currentHighlightedElement.classList.remove(HIGHLIGHT_CLASS);
    currentHighlightedElement = null;
  }
  removeParagraphControl();
}

/**
 * Get the SVG icon for pause or play
 */
function getPauseIcon() {
  return '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
}

function getPlayIcon() {
  return '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M8 5v14l11-7z"/></svg>';
}

/**
 * Show pause/play control button on the highlighted element
 */
function showParagraphControl(element) {
  removeParagraphControl();
  
  const button = document.createElement('button');
  button.id = PARAGRAPH_CONTROL_ID;
  button.innerHTML = isPaused ? getPlayIcon() : getPauseIcon();
  button.title = isPaused ? 'Resume' : 'Pause';
  
  button.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    toggleParagraphPlayback();
  });
  
  element.appendChild(button);
  paragraphControlButton = button;
}

/**
 * Remove the paragraph control button
 */
function removeParagraphControl() {
  if (paragraphControlButton) {
    paragraphControlButton.remove();
    paragraphControlButton = null;
  }
  // Also try to remove by ID in case reference was lost
  const existing = document.getElementById(PARAGRAPH_CONTROL_ID);
  if (existing) existing.remove();
}

/**
 * Update the paragraph control button icon based on pause state
 */
function updateParagraphControlIcon() {
  if (paragraphControlButton) {
    paragraphControlButton.innerHTML = isPaused ? getPlayIcon() : getPauseIcon();
    paragraphControlButton.title = isPaused ? 'Resume' : 'Pause';
  }
}

/**
 * Toggle playback from paragraph control button
 */
function toggleParagraphPlayback() {
  if (isPaused) {
    resumePlayback();
  } else {
    pausePlayback();
  }
  updateParagraphControlIcon();
}

/**
 * Show a "Click to Start Reading" overlay when autoplay is blocked
 * The overlay provides a user gesture that allows audio playback
 */
function showPlayOverlay() {
  // Inject styles first
  injectHighlightStyles();
  
  // Remove existing overlay if any
  removePlayOverlay();
  
  // Create backdrop
  const backdrop = document.createElement('div');
  backdrop.id = 'pocket-reader-overlay-backdrop';
  document.body.appendChild(backdrop);
  
  // Create button
  const button = document.createElement('button');
  button.id = PLAY_OVERLAY_ID;
  button.innerHTML = `
    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <path d="M8 5v14l11-7z"/>
    </svg>
    Click to Start Reading
  `;
  
  button.addEventListener('click', handlePlayOverlayClick);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) {
      // Clicked outside button - cancel playback
      removePlayOverlay();
      if (pendingPlayback) {
        pendingPlayback.reject(new Error('Playback cancelled by user'));
        pendingPlayback = null;
      }
      stopPlayback();
    }
  });
  
  document.body.appendChild(button);
  playOverlayElement = button;
}

/**
 * Remove the play overlay
 */
function removePlayOverlay() {
  const overlay = document.getElementById(PLAY_OVERLAY_ID);
  const backdrop = document.getElementById('pocket-reader-overlay-backdrop');
  if (overlay) overlay.remove();
  if (backdrop) backdrop.remove();
  playOverlayElement = null;
}

/**
 * Handle click on the play overlay - this provides the user gesture needed for audio
 */
function handlePlayOverlayClick() {
  removePlayOverlay();
  
  if (!pendingPlayback) return;
  
  const { audioBlob, onReadyToPrefetch, resolve, reject } = pendingPlayback;
  pendingPlayback = null;
  
  // Now we have a valid user gesture - retry playback
  retryPlayAudioBlob(audioBlob, onReadyToPrefetch, resolve, reject);
}

/**
 * Retry audio playback after user gesture (called from overlay click)
 */
function retryPlayAudioBlob(audioBlob, onReadyToPrefetch, resolve, reject) {
  const audioUrl = URL.createObjectURL(audioBlob);
  pendingAudioUrls.push(audioUrl);
  
  currentAudio = new Audio(audioUrl);
  currentAudio.playbackRate = playbackSpeed;
  
  let prefetchTriggered = false;
  
  currentAudio.ontimeupdate = () => {
    if (
      !prefetchTriggered &&
      currentAudio &&
      currentAudio.duration &&
      currentAudio.currentTime / currentAudio.duration >= 0.7
    ) {
      prefetchTriggered = true;
      if (onReadyToPrefetch) {
        onReadyToPrefetch();
      }
    }
  };
  
  currentAudio.onended = () => {
    URL.revokeObjectURL(audioUrl);
    pendingAudioUrls = pendingAudioUrls.filter((u) => u !== audioUrl);
    currentAudio = null;
    resolve({ stopped: false });
  };
  
  currentAudio.onerror = () => {
    URL.revokeObjectURL(audioUrl);
    pendingAudioUrls = pendingAudioUrls.filter((u) => u !== audioUrl);
    currentAudio = null;
    reject(new Error('Audio playback error'));
  };
  
  currentAudio.play().catch((error) => {
    URL.revokeObjectURL(audioUrl);
    pendingAudioUrls = pendingAudioUrls.filter((u) => u !== audioUrl);
    currentAudio = null;
    reject(error);
  });
}

/**
 * Find the main content container
 */
function findContentContainer() {
  const selectors = [
    'article',
    '[role="main"]',
    'main',
    '.article-content',
    '.post-content',
    '.entry-content',
    '.content',
    '#content',
    '.story-body',
    '.article-body',
    '.post-body',
  ];

  for (const selector of selectors) {
    const element = document.querySelector(selector);
    if (element && element.innerText.trim().length > 200) {
      return element;
    }
  }

  return document.body;
}

/**
 * Check if an element should be excluded from reading
 */
function isExcludedElement(element) {
  const excludedTags = ['SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'NAV', 'HEADER', 'FOOTER', 'ASIDE'];
  if (excludedTags.includes(element.tagName)) return true;
  
  const excludedClasses = [
    'sidebar', 'navigation', 'menu', 'comments', 'comment',
    'advertisement', 'ad', 'ads', 'social-share', 'share-buttons',
    'related-posts', 'recommended'
  ];
  
  const classList = Array.from(element.classList).map(c => c.toLowerCase());
  if (excludedClasses.some(exc => classList.includes(exc))) return true;
  
  const role = element.getAttribute('role');
  if (['navigation', 'banner', 'complementary'].includes(role)) return true;
  
  if (element.getAttribute('aria-hidden') === 'true') return true;
  
  return false;
}

/**
 * Check if an element is visible
 */
function isVisible(element) {
  const style = window.getComputedStyle(element);
  return style.display !== 'none' && 
         style.visibility !== 'hidden' && 
         style.opacity !== '0' &&
         element.offsetParent !== null;
}

/**
 * Extract readable elements from the DOM
 * Returns array of objects with { element, text } for each readable block
 */
function extractReadableElements() {
  const container = findContentContainer();
  const elements = [];
  
  // Selectors for readable content blocks
  const readableSelectors = 'p, h1, h2, h3, h4, h5, h6, li, blockquote, figcaption, td, th, dt, dd, pre';
  
  const candidates = container.querySelectorAll(readableSelectors);
  
  for (const element of candidates) {
    // Skip if inside an excluded parent
    let parent = element.parentElement;
    let excluded = false;
    while (parent && parent !== container) {
      if (isExcludedElement(parent)) {
        excluded = true;
        break;
      }
      parent = parent.parentElement;
    }
    if (excluded) continue;
    
    // Skip if element itself is excluded
    if (isExcludedElement(element)) continue;
    
    // Skip if not visible
    if (!isVisible(element)) continue;
    
    // Get text content
    const text = (element.innerText || element.textContent || '').trim();
    
    // Skip empty or very short elements
    if (text.length < 10) continue;
    
    // Skip if this element's text is entirely contained in a child we'll process later
    // (avoid reading the same content twice)
    const childReadables = element.querySelectorAll(readableSelectors);
    if (childReadables.length > 0) {
      const childText = Array.from(childReadables)
        .map(c => (c.innerText || '').trim())
        .join('');
      if (childText.length >= text.length * 0.9) {
        continue; // Skip parent, children will cover the content
      }
    }
    
    elements.push({
      element: element,
      text: text
    });
  }
  
  return elements;
}

/**
 * Extract the main readable content from the page (legacy, for text-only extraction)
 * Uses various heuristics to find the main article/content area
 */
function extractMainContent() {
  const elements = extractReadableElements();
  const texts = elements.map(e => e.text);
  
  // Prepend title
  const title = getPageTitle();
  if (title) {
    texts.unshift(title);
  }
  
  return texts.join('\n\n');
}

/**
 * Get page title
 */
function getPageTitle() {
  return document.title || '';
}

/**
 * Get a normalized URL for position storage (remove hash and query params)
 */
function getNormalizedUrl() {
  const url = new URL(window.location.href);
  return url.origin + url.pathname;
}

/**
 * Save reading position to chrome storage
 */
function saveReadingPosition(paragraphIndex, total) {
  const url = getNormalizedUrl();
  chrome.storage.local.get('readingPositions', (result) => {
    const positions = result.readingPositions || {};
    positions[url] = {
      index: paragraphIndex,
      total: total,
      timestamp: Date.now()
    };
    chrome.storage.local.set({ readingPositions: positions });
  });
}

/**
 * Clear reading position for current URL
 */
function clearReadingPosition() {
  const url = getNormalizedUrl();
  chrome.storage.local.get('readingPositions', (result) => {
    const positions = result.readingPositions || {};
    delete positions[url];
    chrome.storage.local.set({ readingPositions: positions });
  });
}

/**
 * Send message to popup/background
 */
function notifyExtension(message) {
  chrome.runtime.sendMessage(message).catch(() => {
    // Extension context might be invalid, ignore
  });
}

/**
 * Play audio from blob and return a promise
 * Also accepts an optional onTimeUpdate callback for prefetch timing
 */
function playAudioBlob(audioBlob, onReadyToPrefetch) {
  return new Promise((resolve, reject) => {
    if (shouldStop) {
      resolve({ stopped: true });
      return;
    }

    const audioUrl = URL.createObjectURL(audioBlob);
    pendingAudioUrls.push(audioUrl);

    // Ensure we have an Audio element (reuse across paragraphs)
    ensureAudioElement();

    currentAudio.src = audioUrl;
    currentAudio.playbackRate = playbackSpeed;

    let prefetchTriggered = false;

    // Trigger prefetch when 70% through the audio
    currentAudio.ontimeupdate = () => {
      if (
        !prefetchTriggered &&
        currentAudio &&
        currentAudio.duration &&
        currentAudio.currentTime / currentAudio.duration >= 0.7
      ) {
        prefetchTriggered = true;
        if (onReadyToPrefetch) {
          onReadyToPrefetch();
        }
      }
    };

    currentAudio.onended = () => {
      URL.revokeObjectURL(audioUrl);
      pendingAudioUrls = pendingAudioUrls.filter((u) => u !== audioUrl);
      // Don't set currentAudio to null - reuse it for next paragraph
      resolve({ stopped: false });
    };

    currentAudio.onerror = () => {
      URL.revokeObjectURL(audioUrl);
      pendingAudioUrls = pendingAudioUrls.filter((u) => u !== audioUrl);
      // Don't report error if we intentionally stopped playback
      if (shouldStop) {
        resolve({ stopped: true });
      } else {
        reject(new Error('Audio playback error'));
      }
    };

    currentAudio.play().catch((error) => {
      URL.revokeObjectURL(audioUrl);
      pendingAudioUrls = pendingAudioUrls.filter((u) => u !== audioUrl);
      
      // Check if this is an autoplay policy error
      if (error.name === 'NotAllowedError') {
        // Store pending playback state and show overlay for user gesture
        pendingPlayback = {
          audioBlob,
          onReadyToPrefetch,
          resolve,
          reject
        };
        showPlayOverlay();
        // Don't reject yet - wait for user to click overlay
        return;
      }
      
      reject(error);
    });
  });
}

/**
 * Synthesize a single paragraph - returns a promise for the audio blob
 * Proxied through background script to bypass page CSP restrictions
 */
async function synthesizeParagraph(text, voice) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { action: 'synthesize', text, voice },
      (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (response.error) {
          reject(new Error(response.error));
          return;
        }
        // Convert array back to Blob
        const uint8Array = new Uint8Array(response.audioData);
        const blob = new Blob([uint8Array], { type: response.contentType });
        resolve(blob);
      }
    );
  });
}

/**
 * Get paragraphs from server
 * Proxied through background script to bypass page CSP restrictions
 */
async function getParagraphs(text) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { action: 'getParagraphs', text },
      (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (response.error) {
          reject(new Error(response.error));
          return;
        }
        resolve(response.paragraphs);
      }
    );
  });
}

/**
 * Read paragraphs with prefetching, starting from a specific index
 * @param {Array} paragraphs - Array of paragraph texts OR objects with {text, elementIndex}
 * @param {string} voice - Voice to use
 * @param {number} startIndex - Index to start reading from (0-based)
 * @param {number} speed - Playback speed multiplier
 * @param {boolean} useHighlighting - Whether to highlight elements during reading
 */
async function readParagraphsFromIndex(paragraphs, voice, startIndex = 0, speed = 1.0, useHighlighting = false) {
  shouldStop = false;
  isPaused = false;
  isInPlaybackSession = true;
  playbackSpeed = speed;
  pendingAudioUrls = [];
  totalParagraphs = paragraphs.length;
  currentParagraphIndex = startIndex;

  // Inject highlight styles if we're using highlighting
  if (useHighlighting) {
    injectHighlightStyles();
  }

  const total = paragraphs.length;
  const remaining = total - startIndex;

  try {
    notifyExtension({
      action: 'progress',
      percent: 10,
      text: `Reading from paragraph ${startIndex + 1}/${total}...`,
    });

    // Cache for prefetched audio blobs
    const prefetchedAudio = new Map();

    // Get text from paragraph (handles both string and object formats)
    const getText = (para) => typeof para === 'string' ? para : para.text;
    
    // Get element for highlighting
    const getElement = (para) => {
      if (typeof para === 'object' && para.elementIndex !== undefined) {
        return readableElements[para.elementIndex]?.element;
      }
      return null;
    };

    // Function to prefetch a paragraph
    const prefetchNext = (index) => {
      if (index < paragraphs.length && !prefetchedAudio.has(index) && !shouldStop) {
        synthesizeParagraph(getText(paragraphs[index]), voice)
          .then((blob) => {
            if (!shouldStop) {
              prefetchedAudio.set(index, blob);
            }
          })
          .catch((err) => {
            console.warn(`Prefetch failed for paragraph ${index}:`, err);
          });
      }
    };

    for (let i = startIndex; i < paragraphs.length; i++) {
      if (shouldStop) break;

      currentParagraphIndex = i;

      const progressPercent = 10 + Math.floor(((i - startIndex) / remaining) * 80);

      // Check if we have prefetched audio, otherwise generate it
      let audioBlob;
      if (prefetchedAudio.has(i)) {
        audioBlob = prefetchedAudio.get(i);
        prefetchedAudio.delete(i);
      } else {
        notifyExtension({
          action: 'progress',
          percent: progressPercent,
          text: `Generating ${i + 1}/${total}...`,
        });
        audioBlob = await synthesizeParagraph(getText(paragraphs[i]), voice);
      }

      if (shouldStop) break;

      // Highlight the current element if available
      if (useHighlighting) {
        const element = getElement(paragraphs[i]);
        if (element) {
          highlightElement(element);
        }
      }

      // Notify that we're playing and save position
      notifyExtension({
        action: 'playing',
        current: i + 1,
        total: total,
      });
      
      // Save current position for this URL
      saveReadingPosition(i, total);

      // Start prefetching next paragraph immediately when we start playing
      if (i + 1 < paragraphs.length) {
        prefetchNext(i + 1);
      }

      // Play the audio, with a callback to prefetch even further ahead at 70%
      const result = await playAudioBlob(audioBlob, () => {
        // When 70% through, start prefetching the one after next
        if (i + 2 < paragraphs.length) {
          prefetchNext(i + 2);
        }
      });

      if (result.stopped || shouldStop) break;
    }

    // Remove highlight when done
    removeHighlight();

    if (!shouldStop) {
      // Clear saved position when finished
      clearReadingPosition();
      isInPlaybackSession = false;
      notifyExtension({ action: 'complete' });
    }
  } catch (error) {
    removeHighlight();
    isInPlaybackSession = false;
    console.error('TTS error:', error);
    notifyExtension({ action: 'error', text: error.message });
  }
}

/**
 * Process and read text - extracts paragraphs first
 */
async function readText(text, voice, speed = 1.0) {
  shouldStop = false;
  isPaused = false;
  playbackSpeed = speed;
  pendingAudioUrls = [];

  try {
    notifyExtension({ action: 'progress', percent: 5, text: 'Splitting into paragraphs...' });

    const paragraphs = await getParagraphs(text);

    if (shouldStop) return;

    await readParagraphsFromIndex(paragraphs, voice, 0, speed);
  } catch (error) {
    console.error('TTS error:', error);
    notifyExtension({ action: 'error', text: error.message });
  }
}

/**
 * Stop audio playback
 */
function stopPlayback() {
  shouldStop = true;
  isPaused = false;
  isInPlaybackSession = false;

  if (currentAudio) {
    // Clear handlers before modifying to prevent error callbacks
    clearAudioHandlers();
    currentAudio.pause();
    // Just null out the reference - don't modify src to avoid "Invalid URI" warning
    currentAudio = null;
  }

  // Clean up any pending audio URLs
  for (const url of pendingAudioUrls) {
    URL.revokeObjectURL(url);
  }
  pendingAudioUrls = [];

  // Clear pending playback state and remove overlay
  pendingPlayback = null;
  removePlayOverlay();

  // Remove highlight
  removeHighlight();

  notifyExtension({ action: 'stopped' });
}

/**
 * Pause audio playback
 */
function pausePlayback() {
  if (currentAudio && !isPaused) {
    currentAudio.pause();
    isPaused = true;
    updateParagraphControlIcon();
    notifyExtension({ action: 'paused' });
  }
}

/**
 * Resume audio playback
 */
function resumePlayback() {
  if (currentAudio && isPaused) {
    currentAudio.play().catch((error) => {
      console.error('Resume playback error:', error);
      notifyExtension({ action: 'error', text: 'Failed to resume playback' });
    });
    isPaused = false;
    updateParagraphControlIcon();
    notifyExtension({ action: 'resumed' });
  }
}

/**
 * Listen for messages from popup or background
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'extractContent') {
    try {
      const text = extractMainContent();
      const title = getPageTitle();

      // Prepend title if available
      const fullText = title ? `${title}. ${text}` : text;

      sendResponse({
        success: true,
        text: fullText,
        title: title,
        url: window.location.href,
        length: fullText.length,
      });
    } catch (error) {
      console.error('Error extracting content:', error);
      sendResponse({
        success: false,
        error: error.message,
      });
    }
  } else if (message.action === 'scanElements') {
    // Extract readable elements and store references for highlighting
    try {
      readableElements = extractReadableElements();
      
      // Return just the text for each element (we keep element refs locally)
      const paragraphs = readableElements.map((item, index) => ({
        text: item.text,
        elementIndex: index
      }));
      
      sendResponse({
        success: true,
        paragraphs: paragraphs,
        count: paragraphs.length
      });
    } catch (error) {
      console.error('Error scanning elements:', error);
      sendResponse({
        success: false,
        error: error.message
      });
    }
  } else if (message.action === 'readText') {
    // Read text from the beginning (extracts paragraphs internally)
    readText(message.text, message.voice, message.speed || 1.0);
    sendResponse({ status: 'started' });
  } else if (message.action === 'readParagraphs') {
    // Read pre-scanned paragraphs from a specific index
    // Check if paragraphs have elementIndex (for highlighting)
    const useHighlighting = message.paragraphs.length > 0 && 
                            typeof message.paragraphs[0] === 'object' && 
                            message.paragraphs[0].elementIndex !== undefined;
    readParagraphsFromIndex(
      message.paragraphs, 
      message.voice, 
      message.startIndex || 0, 
      message.speed || 1.0,
      useHighlighting
    );
    sendResponse({ status: 'started' });
  } else if (message.action === 'stop') {
    stopPlayback();
    sendResponse({ status: 'stopped' });
  } else if (message.action === 'pause') {
    pausePlayback();
    sendResponse({ status: 'paused' });
  } else if (message.action === 'resume') {
    resumePlayback();
    sendResponse({ status: 'resumed' });
  } else if (message.action === 'setSpeed') {
    playbackSpeed = message.speed;
    if (currentAudio) {
      currentAudio.playbackRate = playbackSpeed;
    }
    sendResponse({ status: 'speed_set', speed: playbackSpeed });
  } else if (message.action === 'getPlaybackState') {
    // Use isInPlaybackSession flag for reliable state detection
    // The audio element may exist but be primed with silent audio when not playing
    sendResponse({
      isPlaying: isInPlaybackSession && !isPaused,
      isPaused: isInPlaybackSession && isPaused,
      isStopped: !isInPlaybackSession
    });
  } else if (message.action === 'getSavedPosition') {
    const url = getNormalizedUrl();
    chrome.storage.local.get('readingPositions', (result) => {
      const positions = result.readingPositions || {};
      sendResponse(positions[url] || null);
    });
    return true; // Async response
  } else if (message.action === 'clearSavedPosition') {
    clearReadingPosition();
    sendResponse({ status: 'cleared' });
  } else if (message.action === 'readFromHere') {
    // Read from current scroll position to end of page
    handleReadFromHere(message.voice, message.speed);
    sendResponse({ success: true });
  }

  // Return true to indicate async response
  return true;
});

// Store the last right-click position for "read from here"
let lastContextMenuPosition = { x: 0, y: 0 };

// Capture right-click position for "read from here" functionality
document.addEventListener('contextmenu', (e) => {
  lastContextMenuPosition = {
    x: e.clientX,
    y: e.clientY
  };
}, true);

/**
 * Read from right-click position to end of page
 * Finds the first readable paragraph at or below the click position
 */
async function handleReadFromHere(voice, speed) {
  try {
    // Extract all readable paragraphs from page
    const paragraphs = extractReadableElements();

    if (!paragraphs || paragraphs.length === 0) {
      notifyExtension({
        action: 'error',
        text: 'No readable content found on this page'
      });
      return;
    }

    // Use the last right-click position to find the nearest paragraph
    const clickY = lastContextMenuPosition.y;
    let startIndex = 0;
    let minDistance = Infinity;

    for (let i = 0; i < paragraphs.length; i++) {
      if (paragraphs[i].element) {
        const rect = paragraphs[i].element.getBoundingClientRect();

        // Calculate distance from click position to element
        // Prefer elements at or below the click position
        const elementTop = rect.top;
        const elementBottom = rect.bottom;

        let distance;
        if (clickY >= elementTop && clickY <= elementBottom) {
          // Click is inside this element - perfect match
          distance = 0;
        } else if (elementTop >= clickY) {
          // Element is below click - use distance from click to top of element
          distance = elementTop - clickY;
        } else {
          // Element is above click - penalize heavily but still consider
          distance = (clickY - elementBottom) + 10000;
        }

        if (distance < minDistance) {
          minDistance = distance;
          startIndex = i;
        }

        // If we found a perfect match (clicked inside element), use it
        if (distance === 0) {
          break;
        }
      }
    }

    // Clear any existing reading position for this page
    clearReadingPosition();

    // Start reading from this position with highlighting
    await readParagraphsFromIndex(paragraphs, voice, startIndex, speed, true);

  } catch (error) {
    console.error('Error in readFromHere:', error);
    notifyExtension({
      action: 'error',
      text: 'Failed to start reading'
    });
  }
}

// Log that content script is loaded
console.log('Pocket Reader content script loaded');
