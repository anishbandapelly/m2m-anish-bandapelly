/*
  script.js implements the interactive behaviour for Mood‑To‑Memories.
  It handles saving entries to localStorage, rendering them onto the page,
  generating a bar chart of mood frequencies, toggling the dark/light theme,
  and powering a simple chat interface that connects to Google’s generative
  language API (PaLM) using a user‑provided API key.  Replace the
  placeholder key with your own Google API key to enable the chatbot.
*/

(function() {
  /**
   * Gemini API key for accessing Google’s generative models.  To enable
   * affirmative sentence generation, calendar feeling summaries and the
   * chatbot, replace the empty string below with your personal API key.
   *
   * IMPORTANT: Do not leave this value empty if you wish to use the
   * AI‑powered features.  The key will be used directly in API calls and
   * will not be requested from the user at runtime.
   */
  const GEMINI_API_KEY = 'AIzaSyAsehs1M3n6a84ecwe5k49y4If7kEk2DLs';
  // DOM elements
  const entryForm = document.getElementById('entryForm');
  const entriesContainer = document.getElementById('entriesContainer');
  const moodChartCanvas = document.getElementById('moodChart');
  const themeToggle = document.getElementById('themeToggle');
  const chatToggle = document.getElementById('chatToggle');
  const chatWindow = document.getElementById('chatWindow');
  const chatForm = document.getElementById('chatForm');
  const chatMessages = document.getElementById('chatMessages');
  const chatInput = document.getElementById('chatInput');
  const chatCloseBtn = document.getElementById('chatCloseBtn');
  const chatExpandBtn = document.getElementById('chatExpandBtn');

  /**
   * Toggle dark/light mode. Exposed on the window so it can be used in
   * inline HTML attributes. This function updates the body class,
   * persists the selection to localStorage, and updates the icon on
   * the toggle button. It also reapplies the colour theme variables.
   */
  window.toggleTheme = function() {
    const isDark = document.body.classList.toggle('dark');
    const btn = document.getElementById('themeToggle');
    if (btn) {
      btn.textContent = isDark ? '☀️' : '🌙';
    }
    localStorage.setItem('m2mTheme', isDark ? 'dark' : 'light');
    // Reapply colour theme variables after toggling dark mode
    loadColorTheme();
  };

  // Global state
  let entries = [];
  let moodChart;
  let conversationHistory = [];
  let moodList = [];
  let filterMood = null;
  let filterDate = null;
  let currentCalendarDate = new Date();

  // Names of built-in moods that cannot be removed. These are used to
  // differentiate between default moods and custom moods when rendering
  // options and handling deletion.
  const builtInMoodNames = ['Happy', 'Sad', 'Angry', 'Excited', 'Calm'];

  // Cache for generated mixture feelings per date. This prevents
  // repeated API calls for the same day once a mixture has been
  // generated. Keys are date strings (e.g., 'Mon Nov 25 2025'), values
  // are affirmation phrases.
  const mixFeelings = {};

  /**
   * Return an array of the most recent moods for use in affirmation
   * generation. By default returns the moods of the last five entries,
   * but if fewer exist the entire list is returned.
   * @param {number} limit The maximum number of moods to include.
   * @returns {string[]}
   */
  function getRecentMoodsForAffirmation(limit = 5) {
    if (!entries || entries.length === 0) return [];
    const recent = entries.slice(-limit);
    return recent.map(e => e.mood);
  }

  /**
   * Generate a positive affirmation sentence based on a list of moods. If
   * the list is empty, a general affirmation is requested. This function
   * leverages the Gemini API using the user's key. If the API call
   * fails, null is returned and the caller should fall back to a local
   * affirmation.
   *
   * @param {string[]} moods A list of mood names to use as cues.
   * @returns {Promise<string|null>} The generated affirmation or null on error.
   */
  async function generateAffirmationForMoods(moods) {
    try {
      const apiKey = await getApiKey();
      if (!apiKey) return null;
      const modelName = 'gemini-2.5-flash';
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`;
      // Compose the prompt. If moods are provided, instruct the model to
      // incorporate them into a supportive affirmation. Otherwise request
      // a general positive affirmation for journaling.
      let prompt;
      if (moods && moods.length > 0) {
        const unique = Array.from(new Set(moods));
        prompt = `Based on the moods ${unique.join(', ')}, craft a single positive affirmation sentence that encourages the user and helps them reflect constructively. Do not list the moods explicitly; instead weave their essence into the affirmation.`;
      } else {
        prompt = 'Provide a single positive affirmation sentence to encourage reflection and positivity.';
      }
      const requestBody = {
        contents: [
          {
            role: 'user',
            parts: [{ text: prompt }]
          }
        ]
      };
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey
        },
        body: JSON.stringify(requestBody)
      });
      if (!response.ok) throw new Error(`API error: ${response.status}`);
      const data = await response.json();
      const candidate = data?.candidates?.[0];
      if (candidate && candidate.content && candidate.content.parts && candidate.content.parts[0]) {
        const text = candidate.content.parts[0].text;
        return text ? text.trim() : null;
      }
    } catch (err) {
      console.error('generateAffirmationForMoods error', err);
    }
    return null;
  }

  /**
   * Generate a mixture feeling phrase for a given date if there are at
   * least four moods recorded that day. The result is cached in
   * mixFeelings and returned on subsequent calls. The function
   * combines all moods from the date and asks the API to summarise
   * them into a single reflective feeling description.
   *
   * @param {string} dateString A date key from Date.toDateString().
   * @returns {Promise<string|null>} A feeling description or null.
   */
  async function generateMixtureFeelingForDate(dateString) {
    if (!dateString) return null;
    // Return cached result if available
    if (mixFeelings[dateString]) return mixFeelings[dateString];
    // Gather moods for this date
    const dayEntries = entries.filter(e => new Date(e.timestamp).toDateString() === dateString);
    if (dayEntries.length < 4) return null;
    const moods = dayEntries.map(e => e.mood);
    const feeling = await generateAffirmationForMoods(moods);
    if (feeling) {
      mixFeelings[dateString] = feeling;
      return feeling;
    }
    return null;
  }

  /**
   * Compute an average colour for an array of moods by averaging their
   * RGB components. If only one mood is present, its colour is
   * returned. If moods are undefined or colours missing, null is
   * returned.
   *
   * @param {string[]} moods The names of moods to average.
   * @returns {string|null} A CSS hex colour string like '#aabbcc' or null.
   */
  function getAverageColorForMoods(moods) {
    if (!moods || moods.length === 0) return null;
    // Map mood names to colours via moodList
    const colours = moods
      .map(m => moodList.find(x => x.name === m)?.color)
      .filter(Boolean);
    if (colours.length === 0) return null;
    if (colours.length === 1) return colours[0];
    let totalR = 0, totalG = 0, totalB = 0;
    colours.forEach(hex => {
      const c = hex.replace('#', '');
      const r = parseInt(c.substring(0, 2), 16);
      const g = parseInt(c.substring(2, 4), 16);
      const b = parseInt(c.substring(4, 6), 16);
      totalR += r;
      totalG += g;
      totalB += b;
    });
    const len = colours.length;
    const avgR = Math.round(totalR / len);
    const avgG = Math.round(totalG / len);
    const avgB = Math.round(totalB / len);
    const toHex = n => n.toString(16).padStart(2, '0');
    return `#${toHex(avgR)}${toHex(avgG)}${toHex(avgB)}`;
  }

  /**
   * Retrieve the Gemini API key from localStorage or prompt the user.
   * The key is stored under 'm2mGeminiKey' to persist across sessions.
   * @returns {Promise<string|null>} The API key or null if not provided.
   */
  async function getApiKey() {
    // If a key is defined in the GEMINI_API_KEY constant, use it directly.
    if (GEMINI_API_KEY && GEMINI_API_KEY.trim().length > 0) {
      return GEMINI_API_KEY.trim();
    }
    // Otherwise, attempt to load from localStorage (useful if the
    // application saves the key programmatically), but do not prompt
    // the user. If no key is available, return null so fallback
    // behaviour is triggered.
    try {
      const saved = localStorage.getItem('m2mGeminiKey');
      if (saved && saved.trim().length > 0) {
        return saved.trim();
      }
    } catch (e) {
      console.warn('Unable to access localStorage', e);
    }
    return null;
  }

  /**
   * Generate a journaling prompt using the Gemini API. If an API key is not
   * available or the API call fails, a fallback prompt from the local list
   * will be returned. When forceNew is false, a saved prompt from localStorage
   * will be reused to avoid hitting the API on every page load.
   * @param {boolean} forceNew Whether to force a new prompt
   * @returns {Promise<string>} A prompt string
   */
  /**
   * Generate a journaling prompt. This function always attempts to call
   * Google’s Gemini API to fetch a unique prompt. If no API key is
   * available or an error occurs, a random fallback prompt from a
   * predefined list will be returned. Prompts are not stored in
   * localStorage, so each call may yield a new result.
   *
   * @returns {Promise<string>} A prompt string
   */
  async function generatePrompt() {
    const localPrompts = [
      'What made you smile today?',
      'Describe a moment you felt proud of yourself.',
      'What are three things you’re grateful for?',
      'Write about a challenge you overcame recently.',
      'Who is someone that inspired you today?',
      'What did you learn about yourself today?',
      'How would you describe your perfect day?',
      'What’s a small step you can take to improve your wellbeing?',
      'Recall a happy memory from the past week.',
      'Write about a time you felt calm and at peace.'
    ];
    try {
      const apiKey = await getApiKey();
      if (apiKey) {
        const modelName = 'gemini-2.5-flash';
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`;
        const requestBody = {
          contents: [
            {
              role: 'user',
              parts: [{ text: 'Please provide a unique, encouraging journaling prompt in one concise sentence.' }]
            }
          ]
        };
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': apiKey
          },
          body: JSON.stringify(requestBody)
        });
        if (!response.ok) throw new Error(`API error: ${response.status}`);
        const data = await response.json();
        const candidate = data?.candidates?.[0];
        if (
          candidate &&
          candidate.content &&
          candidate.content.parts &&
          candidate.content.parts[0] &&
          candidate.content.parts[0].text
        ) {
          return candidate.content.parts[0].text.trim();
        }
      }
    } catch (err) {
      console.error('Prompt generation failed', err);
    }
    // Fallback: return a random local prompt
    return localPrompts[Math.floor(Math.random() * localPrompts.length)];
  }

  // Load saved entries and theme on startup
  document.addEventListener('DOMContentLoaded', () => {
    loadMoodList();
    loadEntries();
    renderMoodOptions();
    // After rendering moods, attach selection listeners
    attachMoodSelectionEvents();
    renderEntries();
    initChart();
    updateChart();
    loadTheme();
    loadColorTheme();
    // Load the daily affirmation on startup
    loadDailyAffirmation();
    updateTrending();
    updateWordCloud();
    initCalendar();

    // Add smooth scrolling for anchor links.
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
      anchor.addEventListener('click', evt => {
        const targetId = anchor.getAttribute('href');
        if (targetId && targetId.startsWith('#')) {
          const targetEl = document.querySelector(targetId);
          if (targetEl) {
            evt.preventDefault();
            targetEl.scrollIntoView({ behavior: 'smooth' });
          }
        }
      });
    });

    // Make chat window draggable
    initChatDrag();

    // Ensure the chat starts closed on page load. If it was open from a
    // previous session or due to a page reload, remove the 'open' and
    // 'expanded' classes and show the toggle button. Also reset the
    // expand button symbol to the default.
    if (chatWindow) {
      // Ensure chat starts closed and collapsed on load
      chatWindow.classList.remove('open');
      // Reset any inline styles set during expansion
      chatWindow.style.width = '';
      chatWindow.style.height = '';
      chatWindow.style.left = '';
      chatWindow.style.top = '';
      chatWindow.style.bottom = '';
      chatWindow.style.right = '';
      chatWindow.style.transform = '';
      chatWindow.setAttribute('data-expanded', 'false');
      // Reset expand button icon
      chatExpandBtn.textContent = '⛶';
    }
    if (chatToggle) {
      chatToggle.style.display = 'flex';
    }
  });

  /**
   * Load entries from localStorage.  If none exist, initialize to empty array.
   */
  function loadEntries() {
    try {
      const saved = localStorage.getItem('m2mEntries');
      entries = saved ? JSON.parse(saved) : [];
    } catch (err) {
      console.error('Could not parse saved entries', err);
      entries = [];
    }
  }

  /**
   * Save current entries array to localStorage.
   */
  function saveEntries() {
    localStorage.setItem('m2mEntries', JSON.stringify(entries));
  }

  /**
   * Convert a timestamp to a human‑readable date/time string.
   */
  function formatDate(ts) {
    const date = new Date(ts);
    return date.toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
  }

  /**
   * Render all entries into the timeline container.  Entries are shown in
   * reverse chronological order (newest first).  Each card includes a
   * delete button that removes the entry.
   */
  function renderEntries() {
    entriesContainer.innerHTML = '';
       // Determine search/filter criteria (searching disabled; search term is empty)
       const searchTerm = '';
    // Sort entries by timestamp descending
    const sorted = entries.slice().sort((a, b) => b.timestamp - a.timestamp);
    sorted.forEach((entry) => {
      // Filter by selected mood
      if (filterMood && entry.mood !== filterMood) return;
      // Filter by selected date
      if (filterDate && new Date(entry.timestamp).toDateString() !== new Date(filterDate).toDateString()) return;
         // Search functionality removed; do not filter by search term
      const card = document.createElement('div');
      card.className = 'entry-card';
      card.innerHTML = `
        <div class="mood-tag">${escapeHtml(entry.mood)}</div>
        <div class="date">${formatDate(entry.timestamp)}</div>
        <div class="text">${escapeHtml(entry.text)}</div>
        <button class="delete-btn" aria-label="Delete entry">Delete</button>
      `;
      const deleteBtn = card.querySelector('.delete-btn');
      deleteBtn.addEventListener('click', () => {
        const idx = entries.findIndex(e => e.timestamp === entry.timestamp);
        if (idx >= 0) {
          entries.splice(idx, 1);
          saveEntries();
          renderEntries();
          updateChart();
          updateTrending();
          updateWordCloud();
          updateCalendar();
        }
      });
      entriesContainer.appendChild(card);
    });
    // Show or hide filter tag (mood or date)
    const filterTagEl = document.getElementById('filterTag');
    if (filterTagEl) {
      let text = '';
      if (filterMood) {
        text += `Mood: ${filterMood}`;
      }
      if (filterDate) {
        const dateLabel = new Date(filterDate).toLocaleDateString(undefined, { year:'numeric', month:'short', day:'numeric' });
        if (text) text += ' | ';
        text += dateLabel;
      }
      if (text) {
        filterTagEl.style.display = 'inline-block';
        filterTagEl.textContent = text;
      } else {
        filterTagEl.style.display = 'none';
      }
    }
  }

  /**
   * Initialize the Chart.js bar chart that summarizes mood frequencies.
   */
  function initChart() {
    const ctx = moodChartCanvas.getContext('2d');
    // Build initial chart configuration from moodList
    const labels = moodList.map(m => m.name);
    const colors = moodList.map(m => m.color);
    moodChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [{
          label: 'Mood count',
          data: new Array(labels.length).fill(0),
          backgroundColor: colors,
          borderRadius: 4
        }]
      },
      options: {
        plugins: {
          legend: { display: false },
          // Provide a useful tooltip that shows the count and percentage of
          // total entries for each mood. This makes the bar chart more
          // informative and interactive.
          tooltip: {
            callbacks: {
              label: function(context) {
                const value = context.raw;
                const data = context.chart.data.datasets[0].data;
                const total = data.reduce((a, b) => a + b, 0);
                const percent = total ? (value / total * 100).toFixed(1) : 0;
                const moodName = context.label;
                return `${moodName}: ${value} entries (${percent}%)`;
              }
            }
          }
        },
        scales: {
          y: {
            beginAtZero: true,
            ticks: { stepSize: 1 }
          }
        },
        // Custom click event on bar to filter by mood
        onClick: (evt, elements) => {
          if (elements && elements.length > 0) {
            const index = elements[0].index;
            const selectedMood = moodChart.data.labels[index];
            // Toggle filter: if same mood is clicked again, clear filter
            if (filterMood === selectedMood) {
              filterMood = null;
            } else {
              filterMood = selectedMood;
            }
            renderEntries();
          }
        }
      }
    });
  }

  /**
   * Update the bar chart based on current entries.
   */
  function updateChart() {
    // Compute counts for each mood in moodList
    const counts = {};
    moodList.forEach(m => { counts[m.name] = 0; });
    entries.forEach(e => {
      if (counts[e.mood] !== undefined) counts[e.mood]++;
    });
    // Update chart labels and colors in case moods changed
    moodChart.data.labels = moodList.map(m => m.name);
    // Compute colors with highlight if filterMood is set
    moodChart.data.datasets[0].backgroundColor = moodList.map(m => {
      if (filterMood && m.name !== filterMood) {
        // Fade non-selected moods
        return hexToRgba(m.color, 0.3);
      }
      return m.color;
    });
    // Optionally thicken border for selected bar
    moodChart.data.datasets[0].borderColor = moodList.map(m => (filterMood === m.name ? '#000000' : hexToRgba(m.color, 0.5)));
    moodChart.data.datasets[0].borderWidth = moodList.map(m => (filterMood === m.name ? 3 : 1));
    moodChart.data.datasets[0].data = moodList.map(m => counts[m.name] || 0);
    moodChart.update();
  }

  /* -------------------------------------------------------------------------
   * Additional helper functions for enhanced functionality
   *
   * These functions add support for dynamic moods, daily prompts, word
   * frequency analysis, confetti celebrations, and more.  They are grouped
   * below to keep the core logic tidy.
   */

  /**
   * Load mood list from localStorage or initialize with defaults. Each mood
   * includes a name, an icon class (Font Awesome), and a color used for
   * visualisation in the chart.
   */
  function loadMoodList() {
    try {
      const saved = localStorage.getItem('m2mMoods');
      if (saved) {
        moodList = JSON.parse(saved);
      } else {
        moodList = [
          { name: 'Happy', icon: 'fa-smile-beam', color: '#6c63ff' },
          { name: 'Sad', icon: 'fa-frown', color: '#f77754' },
          { name: 'Angry', icon: 'fa-angry', color: '#ff9a56' },
          { name: 'Excited', icon: 'fa-grin-stars', color: '#f0c808' },
          { name: 'Calm', icon: 'fa-spa', color: '#55c57a' }
        ];
      }
      // Filter out any moods with invalid names (e.g., 'gg' or duplicates). This
      // prevents stray placeholder names from persisting between sessions.
      moodList = moodList.filter(m => {
        const name = m.name && m.name.trim();
        if (!name) return false;
        const lower = name.toLowerCase();
        if (lower === 'gg' || lower === 'gg gg') return false;
        return true;
      });
      // Remove duplicate names while preserving the first occurrence.
      const seen = new Set();
      moodList = moodList.filter(m => {
        if (seen.has(m.name)) return false;
        seen.add(m.name);
        return true;
      });
    } catch (err) {
      console.error('Could not load mood list', err);
      moodList = [];
    }
  }

  /**
   * Save the mood list to localStorage.
   */
  function saveMoodList() {
    localStorage.setItem('m2mMoods', JSON.stringify(moodList));
  }

  /**
   * Render mood options based on moodList. Clears existing options and builds
   * radio buttons with icons and labels. Appends the Add mood button at end.
   */
  function renderMoodOptions() {
    const container = document.querySelector('.mood-options');
    if (!container) return;
    container.innerHTML = '';
    moodList.forEach(mood => {
      const label = document.createElement('label');
      label.className = 'mood';
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'mood';
      input.value = mood.name;
      const spanIcon = document.createElement('span');
      spanIcon.className = 'icon';
      const iconEl = document.createElement('i');
      iconEl.className = `fas ${mood.icon}`;
      spanIcon.appendChild(iconEl);
      // Apply mood color as background for the icon
      spanIcon.style.background = mood.color;
      const spanLabel = document.createElement('span');
      spanLabel.className = 'label';
      spanLabel.textContent = mood.name;
      label.appendChild(input);
      label.appendChild(spanIcon);
      label.appendChild(spanLabel);
      // If this mood is not built-in, add a delete button to allow
      // removal of custom moods. Built-in moods remain undeletable.
      if (!builtInMoodNames.includes(mood.name)) {
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'delete-mood-btn';
        delBtn.title = 'Delete mood';
        delBtn.innerHTML = '&times;';
        // Prevent selecting the mood when clicking delete
        delBtn.addEventListener('click', evt => {
          evt.stopPropagation();
          evt.preventDefault();
          deleteMood(mood.name);
        });
        label.appendChild(delBtn);
      }
      container.appendChild(label);
    });
    // Create the Add mood button
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.id = 'addMoodBtn';
    addBtn.className = 'mood add-mood-btn';
    addBtn.innerHTML = '<span class="icon"><i class="fas fa-plus"></i></span><span class="label">Add</span>';
    container.appendChild(addBtn);
    // Attach event listener to open mood modal
    addBtn.addEventListener('click', () => {
      const moodModal = document.getElementById('moodModal');
      if (moodModal) moodModal.classList.add('open');
    });

    // After rendering all moods, attach change listeners for selection
    attachMoodSelectionEvents();
  }

  /**
   * Remove a custom mood by name. Built-in moods are protected and
   * will not be deleted. After removal, the mood list is saved and
   * the UI re-rendered.
   * @param {string} name
   */
  function deleteMood(name) {
    // Do not allow deletion of built-in moods
    if (builtInMoodNames.includes(name)) return;
    moodList = moodList.filter(m => m.name !== name);
    saveMoodList();
    renderMoodOptions();
    updateChart();
  }

  /**
   * Add a custom mood to the list and re-render options.
   * @param {string} name Name of the mood
   * @param {string} color Hex color for the mood icon
   */
  function addCustomMood(name, color) {
       // Use a heart icon for custom moods
       const icon = 'fa-heart';
       if (!name) return;
       // Prevent adding duplicate mood names (case-insensitive). If a mood
       // already exists with the same name, simply update its colour and icon.
       const existing = moodList.find(m => m.name.toLowerCase() === name.toLowerCase());
       if (existing) {
         existing.color = color;
         existing.icon = icon;
       } else {
         moodList.push({ name, icon, color });
       }
       saveMoodList();
       renderMoodOptions();
       updateChart();
  }

  /**
   * Load a random daily quote or journaling prompt. If forceNew is true,
   * always select a new random prompt. Otherwise, reuse stored prompt if
   * available.
   */
  /**
   * Load a journaling prompt into the daily quote area. On initial page load
   * (forceNew = false), a prompt is selected from a small local list to avoid
   * prompting the user for an API key unnecessarily. When forceNew is true,
   * the function attempts to fetch a new prompt from the Gemini API via
   * generatePrompt(). If the API fails or no key is provided, a fallback
   * prompt from the local list is used.  The prompts are not persisted so
   * each call may produce a different result.
   *
   * @param {boolean} forceNew Whether to fetch from the API
   */
  /**
   * Load a daily journaling prompt and display it in the quote area. This
   * function always attempts to fetch a fresh prompt from the Gemini API.
   * If the API call fails or the user has not provided a key, a random
   * fallback prompt from a predefined list will be used instead. Unlike
   * earlier versions, this function no longer caches prompts or reuses
   * previous results; each invocation fetches a new prompt when possible.
   */
  async function loadDailyAffirmation() {
    const affirmationEl = document.querySelector('#dailyAffirmation .affirmation-text');
    if (!affirmationEl) return;
    // Attempt to fetch a new affirmation via the API. We'll use the
    // generateAffirmation function defined later to incorporate recent moods.
    let affirmation;
    try {
      const recentMoods = getRecentMoodsForAffirmation();
      affirmation = await generateAffirmationForMoods(recentMoods);
    } catch (err) {
      console.warn('Failed to generate affirmation, falling back to local affirmations.', err);
    }
    // Define fallback affirmations in case the API call fails. These
    // phrases encourage positivity and reflection without referencing
    // specific moods.
    const fallbackAffirmations = [
      'You are resilient and capable of handling whatever comes your way.',
      'Every day is a new opportunity to grow and learn.',
      'You have the strength to turn challenges into opportunities.',
      'Trust yourself; you are doing your best and it is enough.',
      'Focus on what you can control and let go of the rest.',
      'You are worthy of love and compassion, including your own.',
      'Celebrate your small victories and progress today.',
      'Take a deep breath; you deserve calm and clarity.'
    ];
    if (affirmation) {
      affirmationEl.textContent = affirmation;
    } else {
      const randomAffirmation = fallbackAffirmations[Math.floor(Math.random() * fallbackAffirmations.length)];
      affirmationEl.textContent = randomAffirmation;
    }
  }

  /**
   * Compute trending words from all entry texts and update the display. Uses a
   * simple frequency count excluding common stopwords. Displays the top five
   * words in the trending container.
   */
  function updateTrending() {
    const trendingEl = document.getElementById('trending');
    if (!trendingEl) return;
    const stopwords = new Set(['the','and','to','is','it','in','a','of','on','for','with','that','this','today','i','was','my','me','at']);
    const freq = {};
    entries.forEach(entry => {
      const words = entry.text.toLowerCase().match(/\b[a-z]{3,}\b/g);
      if (words) {
        words.forEach(w => {
          if (!stopwords.has(w)) freq[w] = (freq[w] || 0) + 1;
        });
      }
    });
    const top = Object.entries(freq).sort((a,b) => b[1] - a[1]).slice(0, 5);
    trendingEl.innerHTML = '';
    top.forEach(([word, count]) => {
      const span = document.createElement('span');
      span.className = 'word';
      span.textContent = `${word} (${count})`;
      trendingEl.appendChild(span);
    });
    // Also update the word cloud to reflect new frequencies
    updateWordCloud();
  }

  /**
   * Launch a simple confetti animation after saving an entry. Creates random
   * colored elements that fall from the top of the screen.
   */
  function launchConfetti() {
    const container = document.getElementById('confetti-container');
    if (!container) return;
    const colors = ['#6c63ff', '#f77754', '#ff9a56', '#f0c808', '#55c57a', '#00bcd4'];
    const count = 30;
    for (let i = 0; i < count; i++) {
      const confetto = document.createElement('div');
      confetto.style.position = 'absolute';
      confetto.style.width = '10px';
      confetto.style.height = '10px';
      confetto.style.background = colors[Math.floor(Math.random() * colors.length)];
      confetto.style.left = Math.random() * 100 + '%';
      confetto.style.top = '-20px';
      confetto.style.opacity = 0.8;
      confetto.style.transform = `rotate(${Math.random() * 360}deg)`;
      confetto.style.borderRadius = '2px';
      container.appendChild(confetto);
      // Animate falling
      const duration = 3 + Math.random() * 2;
      confetto.animate([
        { transform: confetto.style.transform, top: '-20px' },
        { transform: `rotate(${Math.random()*360}deg)`, top: '120%' }
      ], {
        duration: duration * 1000,
        easing: 'ease-in',
        fill: 'forwards'
      }).onfinish = () => {
        confetto.remove();
      };
    }
  }

  /**
   * Previously: showEmojiAppreciation() displayed an emoji pop animation when
   * saving an entry. The requirement has changed, and we no longer show
   * any celebratory animations on save. This function is retained as a
   * no‑op to avoid breaking references.
   */
  function showEmojiAppreciation() {
    // Intentionally empty; no celebration effect is shown.
  }

  /**
   * Escape HTML characters to prevent injection of unwanted markup in entries.
   */
  function escapeHtml(str) {
    return str.replace(/[&<>"]/g, c => {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  /**
   * Convert a hex colour code to an rgba string with an optional alpha.
   * @param {string} hex The hex code (e.g. "#ff0000")
   * @param {number} alpha Alpha between 0 and 1
   */
  function hexToRgba(hex, alpha = 1) {
    // Remove leading '#'
    const cleaned = hex.replace('#', '');
    const bigint = parseInt(cleaned, 16);
    const r = (bigint >> 16) & 255;
    const g = (bigint >> 8) & 255;
    const b = bigint & 255;
    return `rgba(${r},${g},${b},${alpha})`;
  }

  /**
   * Keywords used for naive mood analysis to suggest a mood based on entry text.
   * Feel free to expand these lists for richer sentiment detection.
   */
  const moodKeywords = {
    Happy: ['happy','joy','smile','glad','content','cheerful','delighted','bliss'],
    Sad: ['sad','down','unhappy','tearful','sorrow','depressed','cry','blue','lonely'],
    Angry: ['angry','mad','furious','annoyed','rage','frustrated','irritated','upset'],
    Excited: ['excited','thrilled','eager','enthusiastic','pumped','elated'],
    Calm: ['calm','relaxed','peaceful','tranquil','chill','serene','soothe']
  };

  /**
   * Analyse entry text and return the mood with the highest keyword count.
   * Returns null if no keywords are found.
   * @param {string} text
   */
  function analyzeMoodSuggestion(text) {
    const words = (text.match(/\b[a-z]+\b/g) || []).map(w => w.toLowerCase());
    const counts = {};
    Object.keys(moodKeywords).forEach(m => { counts[m] = 0; });
    words.forEach(word => {
      for (const mood in moodKeywords) {
        if (moodKeywords[mood].includes(word)) {
          counts[mood]++;
        }
      }
    });
    let best = null;
    let max = 0;
    for (const mood in counts) {
      if (counts[mood] > max) {
        max = counts[mood];
        best = mood;
      }
    }
    return max > 0 ? best : null;
  }

  /**
   * Update the mood suggestion display based on current entry text.
   */
  function updateMoodSuggestion() {
    const suggestionEl = document.getElementById('moodSuggestion');
    if (!suggestionEl) return;
    const text = document.getElementById('entryText')?.value || '';
    const suggestedMood = analyzeMoodSuggestion(text);
    if (suggestedMood) {
      suggestionEl.textContent = `Suggested mood: ${suggestedMood}`;
    } else {
      suggestionEl.textContent = '';
    }
  }

  /**
   * Attach change listeners to mood radio inputs so that the selected mood
   * is visibly highlighted before the entry is saved. This function should
   * be called after mood options have been rendered or updated.
   */
  function attachMoodSelectionEvents() {
    const moodLabels = document.querySelectorAll('.mood-options .mood');
    moodLabels.forEach(label => {
      const input = label.querySelector('input[type="radio"]');
      if (input) {
        input.addEventListener('change', () => {
          // On selection change, remove selected class from all moods
          moodLabels.forEach(l => {
            l.classList.remove('selected');
          });
          // Add selected class to the chosen mood to apply highlight styles
          if (input.checked) {
            label.classList.add('selected');
          }
        });
      }
    });
  }

  /**
   * Initialise dragging behaviour for the chatbot. Clicking and dragging
   * the chat header will reposition the chat window anywhere on the screen.
   */
  function initChatDrag() {
    const popup = document.getElementById('chatWindow');
    const header = popup?.querySelector('.chat-header');
    if (!header || !popup) return;
    let isDragging = false;
    let offsetX = 0;
    let offsetY = 0;
    header.addEventListener('mousedown', e => {
      isDragging = true;
      const rect = popup.getBoundingClientRect();
      offsetX = e.clientX - rect.left;
      offsetY = e.clientY - rect.top;
      // Bring to front while dragging
      popup.style.zIndex = '2000';
      // Set explicit top and left so the element can move via drag.
      popup.style.top = `${rect.top}px`;
      popup.style.left = `${rect.left}px`;
      // Remove anchoring from bottom/right to avoid conflicting positioning
      popup.style.bottom = 'auto';
      popup.style.right = 'auto';
    });
    document.addEventListener('mousemove', e => {
      if (!isDragging) return;
      const x = e.clientX - offsetX;
      const y = e.clientY - offsetY;
      popup.style.left = `${x}px`;
      popup.style.top = `${y}px`;
    });
    document.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false;
      }
    });
  }

  // Attach input listener for mood suggestion
  const entryTextEl = document.getElementById('entryText');
  if (entryTextEl) {
    entryTextEl.addEventListener('input', updateMoodSuggestion);
  }

  /**
   * Initialise the calendar by setting the date to the first of the current month
   * and rendering the grid.  Called on page load and when month changes.
   */
  function initCalendar() {
    // Ensure currentCalendarDate is the first day of the month
    currentCalendarDate.setDate(1);
    updateCalendar();
  }

  /**
   * Update the calendar grid based on currentCalendarDate and entries.
   */
  function updateCalendar() {
    const grid = document.getElementById('calendarGrid');
    const monthLabel = document.getElementById('calendarMonthLabel');
    if (!grid || !monthLabel) return;
    grid.innerHTML = '';
    const year = currentCalendarDate.getFullYear();
    const month = currentCalendarDate.getMonth();
    const firstDay = new Date(year, month, 1);
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const startDayIndex = firstDay.getDay(); // 0=Sunday
    // Set month label
    monthLabel.textContent = currentCalendarDate.toLocaleString(undefined, { month: 'long', year: 'numeric' });
    // Fill blanks for days of previous month
    for (let i = 0; i < startDayIndex; i++) {
      const blank = document.createElement('div');
      blank.className = 'day empty';
      grid.appendChild(blank);
    }
    // Populate days
    for (let day = 1; day <= daysInMonth; day++) {
      const dateKey = new Date(year, month, day);
      const cell = document.createElement('div');
      cell.className = 'day';
      const num = document.createElement('div');
      num.className = 'date-number';
      num.textContent = day;
      cell.appendChild(num);
      // Determine the list of moods recorded on this date
      const dateString = dateKey.toDateString();
      const dayMoods = entries
        .filter(e => new Date(e.timestamp).toDateString() === dateString)
        .map(e => e.mood);
      // Display a dot for each unique mood instead of blending colours.
      // If multiple moods are recorded, show up to three dots in the
      // bottom right corner. Each dot uses the associated mood colour
      // from the mood list. If no moods, no indicators are added.
      const uniqueMoods = Array.from(new Set(dayMoods));
      if (uniqueMoods.length > 0) {
        const indicatorsContainer = document.createElement('div');
        indicatorsContainer.className = 'mood-indicators';
        uniqueMoods.slice(0, 3).forEach(moodName => {
          const moodObj = moodList.find(m => m.name === moodName);
          if (moodObj) {
            const dot = document.createElement('div');
            dot.className = 'mood-dot';
            dot.style.background = moodObj.color;
            indicatorsContainer.appendChild(dot);
          }
        });
        cell.appendChild(indicatorsContainer);
      }
      // If there are at least four moods, generate and attach a
      // mixture feeling description asynchronously. The resulting
      // phrase is set as the cell's title and displayed as a subtitle.
      if (dayMoods.length >= 4) {
        generateMixtureFeelingForDate(dateString).then(feeling => {
          let phrase = feeling;
          // If no phrase was generated (e.g., missing API key), build a
          // simple fallback using the unique moods. This ensures users
          // still see a mixture description even without API access.
          if (!phrase) {
            const summary = uniqueMoods.join(', ');
            phrase = `Mixed feelings: ${summary}`;
          }
          if (phrase) {
            cell.title = phrase;
            const textEl = document.createElement('div');
            textEl.className = 'feeling-text';
            textEl.textContent = phrase;
            cell.appendChild(textEl);
          }
        });
      }
      // Click to filter by date
      cell.addEventListener('click', () => {
        // Toggle filter date
        if (filterDate && new Date(filterDate).toDateString() === dateString) {
          filterDate = null;
        } else {
          filterDate = dateKey;
        }
        renderEntries();
      });
      grid.appendChild(cell);
    }
    // Fill trailing blanks to complete the grid (if needed)
    const cellsCount = startDayIndex + daysInMonth;
    const remainder = cellsCount % 7;
    if (remainder !== 0) {
      for (let i = remainder; i < 7; i++) {
        const blank = document.createElement('div');
        blank.className = 'day empty';
        grid.appendChild(blank);
      }
    }
  }

  /**
   * Compute the dominant mood colour for a given date string (from toDateString). If no entries for that
   * date exist, returns null.
   * @param {string} dateString
   */
  function getDominantMoodColorForDate(dateString) {
    // Filter entries to those matching the date (ignoring time)
    const dayEntries = entries.filter(e => new Date(e.timestamp).toDateString() === dateString);
    if (!dayEntries.length) return null;
    const counts = {};
    dayEntries.forEach(e => {
      counts[e.mood] = (counts[e.mood] || 0) + 1;
    });
    let topMood = null;
    let topCount = 0;
    for (const m in counts) {
      if (counts[m] > topCount) {
        topCount = counts[m];
        topMood = m;
      }
    }
    const moodObj = moodList.find(m => m.name === topMood);
    return moodObj ? moodObj.color : null;
  }

  /**
   * Update the word cloud based on word frequencies in entries. Words are placed
   * randomly within the container with font size proportional to their counts.
   */
  function updateWordCloud() {
    const cloud = document.getElementById('wordCloud');
    if (!cloud) return;
    cloud.innerHTML = '';
    // Compute frequencies as in updateTrending but allow more words
    const stopwords = new Set(['the','and','to','is','it','in','a','of','on','for','with','that','this','today','i','was','my','me','at','had','have','has','you','we']);
    const freq = {};
    entries.forEach(entry => {
      const words = entry.text.toLowerCase().match(/\b[a-z]{3,}\b/g);
      if (words) {
        words.forEach(w => {
          if (!stopwords.has(w)) freq[w] = (freq[w] || 0) + 1;
        });
      }
    });
    const entriesArr = Object.entries(freq).sort((a,b) => b[1] - a[1]).slice(0, 20);
    if (entriesArr.length === 0) return;
    const maxCount = entriesArr[0][1];
    const colors = ['#6c63ff', '#f77754', '#ff9a56', '#f0c808', '#55c57a', '#00bcd4', '#e94e77'];
    entriesArr.forEach(([word, count]) => {
      const span = document.createElement('span');
      span.textContent = word;
      const size = 1 + (count / maxCount) * 2; // 1rem to 3rem
      span.style.fontSize = size + 'rem';
      span.style.color = colors[Math.floor(Math.random() * colors.length)];
      // Random positions within container (0 to 80%)
      span.style.top = Math.random() * 80 + '%';
      span.style.left = Math.random() * 80 + '%';
      span.style.transform = `rotate(${(Math.random() * 30 - 15).toFixed(2)}deg)`;
      cloud.appendChild(span);
    });
  }

  /**
   * Apply the saved colour theme to the body. The value stored is one of
   * 'default', 'neon' or 'sunset'.  When switching, remove other theme classes.
   */
  function loadColorTheme() {
    const saved = localStorage.getItem('m2mColorTheme') || 'default';
    document.body.classList.remove('theme-neon', 'theme-sunset');
    if (saved === 'neon') {
      document.body.classList.add('theme-neon');
    } else if (saved === 'sunset') {
      document.body.classList.add('theme-sunset');
    }
    // Update active state on swatches
    const buttons = document.querySelectorAll('#themePicker .theme-btn');
    buttons.forEach(btn => {
      btn.classList.remove('active');
      if (btn.getAttribute('data-theme') === saved) {
        btn.classList.add('active');
      }
    });
  }

  // Event listeners for theme buttons
  document.addEventListener('DOMContentLoaded', () => {
    const themeButtons = document.querySelectorAll('#themePicker .theme-btn');
    themeButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        const theme = btn.getAttribute('data-theme');
        // Save and apply theme
        localStorage.setItem('m2mColorTheme', theme);
        loadColorTheme();
      });
    });
  });

  // Event listeners for calendar navigation
  document.addEventListener('DOMContentLoaded', () => {
    const prevBtn = document.getElementById('prevMonthBtn');
    const nextBtn = document.getElementById('nextMonthBtn');
    if (prevBtn) {
      prevBtn.addEventListener('click', () => {
        currentCalendarDate.setMonth(currentCalendarDate.getMonth() - 1);
        currentCalendarDate.setDate(1);
        updateCalendar();
      });
    }
    if (nextBtn) {
      nextBtn.addEventListener('click', () => {
        currentCalendarDate.setMonth(currentCalendarDate.getMonth() + 1);
        currentCalendarDate.setDate(1);
        updateCalendar();
      });
    }
  });

  // Handle journal form submission
  entryForm.addEventListener('submit', event => {
    event.preventDefault();
    const formData = new FormData(entryForm);
    const mood = formData.get('mood');
    const text = formData.get('entryText').trim();
    if (!mood || !text) return;
    const entry = {
      mood,
      text,
      timestamp: Date.now()
    };
    entries.push(entry);
    saveEntries();
    renderEntries();
    updateChart();
    updateTrending();
    updateWordCloud();
    updateCalendar();
      // Celebration effects disabled. Previously, the app would launch
      // confetti or emoji animations after a save. The requirement now is
      // to remove any visual popups on save, so we no longer call
      // showEmojiAppreciation() or launchConfetti().
    entryForm.reset();
  });

  // Theme toggle behaviour is handled by the global toggleTheme() function
  // defined above. The button has an inline onclick attribute to invoke
  // toggleTheme() directly, avoiding double toggles.

    // Search and filter tag functionality removed. Mood and date filters
    // can still be toggled by clicking on the bar chart or calendar cells.

  // Add mood modal behaviour
  const addMoodBtn = document.getElementById('addMoodBtn');
  const moodModal = document.getElementById('moodModal');
  const saveMoodBtn = document.getElementById('saveMoodBtn');
  const cancelMoodBtn = document.getElementById('cancelMoodBtn');
  if (addMoodBtn && moodModal) {
    addMoodBtn.addEventListener('click', () => {
      moodModal.classList.add('open');
    });
    cancelMoodBtn?.addEventListener('click', () => {
      moodModal.classList.remove('open');
    });
    saveMoodBtn?.addEventListener('click', () => {
      const name = document.getElementById('newMoodName').value.trim();
      const color = document.getElementById('newMoodColor').value;
      if (!name) return;
      addCustomMood(name, color);
      document.getElementById('newMoodName').value = '';
      document.getElementById('newMoodColor').value = '#ffb74d';
      moodModal.classList.remove('open');
    });
  }

  // Random prompt / quote behaviour
  const newAffirmationBtn = document.getElementById('newAffirmationBtn');
  if (newAffirmationBtn) {
    newAffirmationBtn.addEventListener('click', () => {
      // Always fetch a fresh affirmation on button click. loadDailyAffirmation()
      // attempts to call the Gemini API each time.
      loadDailyAffirmation();
    });
  }

  // Export entries to JSON file
  const exportBtn = document.getElementById('exportBtn');
  if (exportBtn) {
    exportBtn.addEventListener('click', () => {
      if (entries.length === 0) {
        alert('No entries to export.');
        return;
      }
      const dataStr = JSON.stringify(entries, null, 2);
      const blob = new Blob([dataStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'mood-entries.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    });
  }

  /**
   * Load the saved theme from localStorage and apply it.
   */
  function loadTheme() {
    const saved = localStorage.getItem('m2mTheme');
    if (saved === 'dark') {
      document.body.classList.add('dark');
      themeToggle.textContent = '☀️';
      // When loading dark theme on start, ensure colour theme is reapplied
      loadColorTheme();
    }
  }

  // Chat widget open/close
  chatToggle.addEventListener('click', () => {
    chatWindow.classList.add('open');
    chatToggle.style.display = 'none';
  });
  chatCloseBtn.addEventListener('click', () => {
    chatWindow.classList.remove('open');
    chatToggle.style.display = 'flex';
    // Also collapse if it was expanded
    chatWindow.style.width = '';
    chatWindow.style.height = '';
    chatWindow.style.left = '';
    chatWindow.style.top = '';
    chatWindow.style.bottom = '';
    chatWindow.style.right = '';
    chatWindow.style.transform = '';
    chatWindow.setAttribute('data-expanded', 'false');
    chatExpandBtn.textContent = '⛶';
  });

  // Expand/contract chat window. We explicitly set inline styles instead of
  // relying solely on CSS classes to avoid positioning issues when the
  // window is moved or resized. A data attribute tracks the current state.
  chatExpandBtn.addEventListener('click', () => {
    if (!chatWindow) return;
    const expanded = chatWindow.getAttribute('data-expanded') === 'true';
    if (expanded) {
      // Collapse back to the default size and position (bottom right)
      chatWindow.style.width = '';
      chatWindow.style.height = '';
      chatWindow.style.left = '';
      chatWindow.style.top = '';
      chatWindow.style.right = '20px';
      chatWindow.style.bottom = '80px';
      chatWindow.style.transform = '';
      chatWindow.setAttribute('data-expanded', 'false');
      // Update the button to show the expand symbol
      chatExpandBtn.textContent = '⛶';
    } else {
      // Expand: increase dimensions and anchor near the top-right of the viewport.
      chatWindow.style.width = '90vw';
      chatWindow.style.height = '70vh';
      chatWindow.style.left = '';
      chatWindow.style.bottom = '';
      chatWindow.style.right = '20px';
      chatWindow.style.top = '10vh';
      chatWindow.style.transform = '';
      chatWindow.setAttribute('data-expanded', 'true');
      // Update the button to show the minimise symbol
      chatExpandBtn.textContent = '🗗';
    }
  });

  // Handle chat form submission
  chatForm.addEventListener('submit', async event => {
    event.preventDefault();
    const message = chatInput.value.trim();
    if (!message) return;
    appendMessage(message, 'user');
    chatInput.value = '';
    await sendChatMessage(message);
  });

  /**
   * Append a message to the chat UI.
   * @param {string} text The message text
   * @param {string} author 'user' or 'bot'
   */
  function appendMessage(text, author) {
    const msg = document.createElement('div');
    msg.className = `message ${author}`;
    // Safely convert special characters and render bold markdown (**text**)
    let html = text;
    // Escape HTML brackets first
    html = html
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    // Replace markdown bold (**text**) with <strong>
    html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    // Replace newlines with <br>
    html = html.replace(/\n/g, '<br>');
    msg.innerHTML = html;
    chatMessages.appendChild(msg);
    // Scroll to bottom
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  /**
   * Send a chat message to the Google Generative Language API and append the
   * response.  You must replace the placeholder API key with a valid key in
   * order for this function to work.  If the request fails, an error message
   * will be shown instead.
   * @param {string} userMessage
   */
  async function sendChatMessage(userMessage) {
    // Add message to conversation history
    conversationHistory.push({ role: 'user', content: userMessage });
    try {
      // Retrieve the API key from storage or prompt the user
      const apiKey = await getApiKey();
      if (!apiKey) {
        appendMessage('Error: No Gemini API key provided.', 'bot');
        return;
      }
      // Use the latest Gemini model for chat. See docs for supported models.
      const modelName = 'gemini-2.5-flash';
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`;
      // Build conversation history for Gemini API. Prepend a context message
      // summarising recent moods to guide the model. We insert this at the
      // beginning of the conversation so that the assistant can tailor its
      // responses accordingly. The context uses the 'user' role per
      // Gemini API requirements.
      const recent = getRecentMoodsForAffirmation(5);
      let contextPrompt;
      if (recent && recent.length > 0) {
        const unique = Array.from(new Set(recent));
        // Compose a detailed system instruction to inform the model
        // about the user's recent moods and the desired tone of the
        // conversation. The assistant should weave these moods into
        // empathetic guidance and help the user turn tough days into
        // meaningful actions.
           contextPrompt = `You are a friendly domain‑specific journaling assistant. The user has recently logged the moods: ${unique.join(', ')}. Use these moods as cues to discuss their day, reflect positively on their emotions, and offer gentle suggestions for turning tough or overwhelmed feelings into meaningful actions. In your replies, help the user find more meaning and purpose in their life by encouraging self‑discovery and intentional growth. Provide empathy, encouragement and constructive reflection without explicitly listing the moods.`;
      } else {
           contextPrompt = 'You are a friendly journaling assistant. The user seeks supportive, reflective guidance. Provide empathetic responses that encourage positive self‑reflection, help them find meaning and purpose, and transform challenges into constructive actions.';
      }
      const contents = [];
      contents.push({
        role: 'user',
        parts: [{ text: contextPrompt }]
      });
      // Append the actual conversation history
      conversationHistory.forEach(m => {
        contents.push({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }]
        });
      });
      const payload = { contents };
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Pass API key via HTTP header as recommended by Google AI docs
          'X-Goog-Api-Key': apiKey
        },
        body: JSON.stringify(payload)
      });
      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }
      const data = await response.json();
      // Extract the model's reply. Gemini returns candidates array with content.parts
      const candidate = data?.candidates?.[0];
      let reply = 'Sorry, I didn\'t catch that.';
      if (candidate && candidate.content && candidate.content.parts && candidate.content.parts[0]) {
        reply = candidate.content.parts[0].text;
      }
      conversationHistory.push({ role: 'assistant', content: reply });
      appendMessage(reply, 'bot');
    } catch (err) {
      console.error(err);
      appendMessage('Oops! Something went wrong while contacting the API.', 'bot');
    }
  }
})();