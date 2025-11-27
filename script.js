/*
  script.js implements the interactive behaviour for Mood-To-Memories.
  It handles saving entries to localStorage, rendering them onto the page,
  generating a bar chart of mood frequencies, toggling the dark/light theme,
  and powering a simple chat interface that connects to Google’s generative
  language API (Gemini/PaLM) using an API key.

  You can either:
  - Hard-code your Gemini API key in GEMINI_API_KEY for private/local builds, or
  - Leave it empty and the website will ask the user to enter an API key
    the first time an AI feature is used, then store it in this browser only.
*/

(function() {
  /**
   * Gemini API key for accessing Google’s generative models.
   *
   * For PUBLIC builds (GitHub Pages, etc.), leave this as an empty string.
   * The app will then prompt the user to enter their own Gemini API key
   * and store it in localStorage under 'm2mGeminiKey'.
   *
   * For PRIVATE/LOCAL builds, you may optionally put your key here:
   *   const GEMINI_API_KEY = "sk-...your-key...";
   * In that case, the app will not prompt and will use this constant.
   */
  const GEMINI_API_KEY = ""; // leave empty in public builds

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

  // Names of built-in moods that cannot be removed.
  const builtInMoodNames = ['Happy', 'Sad', 'Angry', 'Excited', 'Calm'];

  // Cache for generated mixture feelings per date.
  const mixFeelings = {};

  /**
   * Return an array of the most recent moods for use in affirmation
   * generation.
   */
  function getRecentMoodsForAffirmation(limit = 5) {
    if (!entries || entries.length === 0) return [];
    const recent = entries.slice(-limit);
    return recent.map(e => e.mood);
  }

  /**
   * Generate a positive affirmation sentence based on a list of moods.
   */
  async function generateAffirmationForMoods(moods) {
    try {
      const apiKey = await getApiKey();
      if (!apiKey) return null;
      const modelName = 'gemini-2.5-flash';
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`;
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
   * Generate a mixture feeling phrase for a given date.
   */
  async function generateMixtureFeelingForDate(dateString) {
    if (!dateString) return null;
    if (mixFeelings[dateString]) return mixFeelings[dateString];
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
   * Compute an average colour for an array of moods.
   */
  function getAverageColorForMoods(moods) {
    if (!moods || moods.length === 0) return null;
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
   * Retrieve the Gemini API key for AI features.
   *
   * Priority:
   * 1. If GEMINI_API_KEY constant is set (non-empty), use that.
   * 2. Else, try to read from localStorage ('m2mGeminiKey').
   * 3. If still missing, PROMPT the user to enter a key once,
   *    store it in localStorage, and reuse it next time.
   *
   * @returns {Promise<string|null>} The API key or null if user cancels.
   */
  async function getApiKey() {
    // 1. Use constant if provided (for local/private builds)
    if (GEMINI_API_KEY && GEMINI_API_KEY.trim().length > 0) {
      return GEMINI_API_KEY.trim();
    }

    // 2. Check localStorage
    let saved = null;
    try {
      saved = localStorage.getItem('m2mGeminiKey');
    } catch (e) {
      console.warn('Unable to access localStorage', e);
    }
    if (saved && saved.trim().length > 0) {
      return saved.trim();
    }

    // 3. Ask user via prompt (first time only) for public builds
    const entered = window.prompt(
      'To enable AI features (chatbot, affirmations, mood summaries), please enter your Gemini API key. ' +
      'This key will be stored only in this browser and used only to call Google\'s API.'
    );
    if (entered && entered.trim().length > 0) {
      const trimmed = entered.trim();
      try {
        localStorage.setItem('m2mGeminiKey', trimmed);
      } catch (e) {
        console.warn('Unable to save Gemini API key to localStorage', e);
      }
      return trimmed;
    }

    // User cancelled or empty input → no key available
    return null;
  }

  /**
   * Generate a journaling prompt (AI if possible, fallback otherwise).
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

    // Smooth scrolling for anchor links
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

    // Ensure the chat starts closed on page load.
    if (chatWindow) {
      chatWindow.classList.remove('open');
      chatWindow.style.width = '';
      chatWindow.style.height = '';
      chatWindow.style.left = '';
      chatWindow.style.top = '';
      chatWindow.style.bottom = '';
      chatWindow.style.right = '';
      chatWindow.style.transform = '';
      chatWindow.setAttribute('data-expanded', 'false');
      chatExpandBtn.textContent = '⛶';
    }
    if (chatToggle) {
      chatToggle.style.display = 'flex';
    }
  });

  function loadEntries() {
    try {
      const saved = localStorage.getItem('m2mEntries');
      entries = saved ? JSON.parse(saved) : [];
    } catch (err) {
      console.error('Could not parse saved entries', err);
      entries = [];
    }
  }

  function saveEntries() {
    localStorage.setItem('m2mEntries', JSON.stringify(entries));
  }

  function formatDate(ts) {
    const date = new Date(ts);
    return date.toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
  }

  function renderEntries() {
    entriesContainer.innerHTML = '';
    const searchTerm = ''; // search disabled
    const sorted = entries.slice().sort((a, b) => b.timestamp - a.timestamp);
    sorted.forEach((entry) => {
      if (filterMood && entry.mood !== filterMood) return;
      if (filterDate && new Date(entry.timestamp).toDateString() !== new Date(filterDate).toDateString()) return;
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
    const filterTagEl = document.getElementById('filterTag');
    if (filterTagEl) {
      let text = '';
      if (filterMood) text += `Mood: ${filterMood}`;
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

  function initChart() {
    const ctx = moodChartCanvas.getContext('2d');
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
        onClick: (evt, elements) => {
          if (elements && elements.length > 0) {
            const index = elements[0].index;
            const selectedMood = moodChart.data.labels[index];
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

  function updateChart() {
    const counts = {};
    moodList.forEach(m => { counts[m.name] = 0; });
    entries.forEach(e => {
      if (counts[e.mood] !== undefined) counts[e.mood]++;
    });
    moodChart.data.labels = moodList.map(m => m.name);
    moodChart.data.datasets[0].backgroundColor = moodList.map(m => {
      if (filterMood && m.name !== filterMood) {
        return hexToRgba(m.color, 0.3);
      }
      return m.color;
    });
    moodChart.data.datasets[0].borderColor = moodList.map(m => (filterMood === m.name ? '#000000' : hexToRgba(m.color, 0.5)));
    moodChart.data.datasets[0].borderWidth = moodList.map(m => (filterMood === m.name ? 3 : 1));
    moodChart.data.datasets[0].data = moodList.map(m => counts[m.name] || 0);
    moodChart.update();
  }

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
      moodList = moodList.filter(m => {
        const name = m.name && m.name.trim();
        if (!name) return false;
        const lower = name.toLowerCase();
        if (lower === 'gg' || lower === 'gg gg') return false;
        return true;
      });
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

  function saveMoodList() {
    localStorage.setItem('m2mMoods', JSON.stringify(moodList));
  }

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
      spanIcon.style.background = mood.color;
      const spanLabel = document.createElement('span');
      spanLabel.className = 'label';
      spanLabel.textContent = mood.name;
      label.appendChild(input);
      label.appendChild(spanIcon);
      label.appendChild(spanLabel);
      if (!builtInMoodNames.includes(mood.name)) {
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'delete-mood-btn';
        delBtn.title = 'Delete mood';
        delBtn.innerHTML = '&times;';
        delBtn.addEventListener('click', evt => {
          evt.stopPropagation();
          evt.preventDefault();
          deleteMood(mood.name);
        });
        label.appendChild(delBtn);
      }
      container.appendChild(label);
    });
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.id = 'addMoodBtn';
    addBtn.className = 'mood add-mood-btn';
    addBtn.innerHTML = '<span class="icon"><i class="fas fa-plus"></i></span><span class="label">Add</span>';
    container.appendChild(addBtn);
    addBtn.addEventListener('click', () => {
      const moodModal = document.getElementById('moodModal');
      if (moodModal) moodModal.classList.add('open');
    });
    attachMoodSelectionEvents();
  }

  function deleteMood(name) {
    if (builtInMoodNames.includes(name)) return;
    moodList = moodList.filter(m => m.name !== name);
    saveMoodList();
    renderMoodOptions();
    updateChart();
  }

  function addCustomMood(name, color) {
    const icon = 'fa-heart';
    if (!name) return;
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

  async function loadDailyAffirmation() {
    const affirmationEl = document.querySelector('#dailyAffirmation .affirmation-text');
    if (!affirmationEl) return;
    let affirmation;
    try {
      const recentMoods = getRecentMoodsForAffirmation();
      affirmation = await generateAffirmationForMoods(recentMoods);
    } catch (err) {
      console.warn('Failed to generate affirmation, falling back to local affirmations.', err);
    }
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
    updateWordCloud();
  }

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

  function showEmojiAppreciation() {
    // Intentionally empty; no celebration effect is shown.
  }

  function escapeHtml(str) {
    return str.replace(/[&<>"]/g, c => {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function hexToRgba(hex, alpha = 1) {
    const cleaned = hex.replace('#', '');
    const bigint = parseInt(cleaned, 16);
    const r = (bigint >> 16) & 255;
    const g = (bigint >> 8) & 255;
    const b = bigint & 255;
    return `rgba(${r},${g},${b},${alpha})`;
  }

  const moodKeywords = {
    Happy: ['happy','joy','smile','glad','content','cheerful','delighted','bliss'],
    Sad: ['sad','down','unhappy','tearful','sorrow','depressed','cry','blue','lonely'],
    Angry: ['angry','mad','furious','annoyed','rage','frustrated','irritated','upset'],
    Excited: ['excited','thrilled','eager','enthusiastic','pumped','elated'],
    Calm: ['calm','relaxed','peaceful','tranquil','chill','serene','soothe']
  };

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

  function attachMoodSelectionEvents() {
    const moodLabels = document.querySelectorAll('.mood-options .mood');
    moodLabels.forEach(label => {
      const input = label.querySelector('input[type="radio"]');
      if (input) {
        input.addEventListener('change', () => {
          moodLabels.forEach(l => {
            l.classList.remove('selected');
          });
          if (input.checked) {
            label.classList.add('selected');
          }
        });
      }
    });
  }

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
      popup.style.zIndex = '2000';
      popup.style.top = `${rect.top}px`;
      popup.style.left = `${rect.left}px`;
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

  const entryTextEl = document.getElementById('entryText');
  if (entryTextEl) {
    entryTextEl.addEventListener('input', updateMoodSuggestion);
  }

  function initCalendar() {
    currentCalendarDate.setDate(1);
    updateCalendar();
  }

  function updateCalendar() {
    const grid = document.getElementById('calendarGrid');
    const monthLabel = document.getElementById('calendarMonthLabel');
    if (!grid || !monthLabel) return;
    grid.innerHTML = '';
    const year = currentCalendarDate.getFullYear();
    const month = currentCalendarDate.getMonth();
    const firstDay = new Date(year, month, 1);
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const startDayIndex = firstDay.getDay();
    monthLabel.textContent = currentCalendarDate.toLocaleString(undefined, { month: 'long', year: 'numeric' });
    for (let i = 0; i < startDayIndex; i++) {
      const blank = document.createElement('div');
      blank.className = 'day empty';
      grid.appendChild(blank);
    }
    for (let day = 1; day <= daysInMonth; day++) {
      const dateKey = new Date(year, month, day);
      const cell = document.createElement('div');
      cell.className = 'day';
      const num = document.createElement('div');
      num.className = 'date-number';
      num.textContent = day;
      cell.appendChild(num);
      const dateString = dateKey.toDateString();
      const dayMoods = entries
        .filter(e => new Date(e.timestamp).toDateString() === dateString)
        .map(e => e.mood);
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
      if (dayMoods.length >= 4) {
        generateMixtureFeelingForDate(dateString).then(feeling => {
          let phrase = feeling;
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
      cell.addEventListener('click', () => {
        if (filterDate && new Date(filterDate).toDateString() === dateString) {
          filterDate = null;
        } else {
          filterDate = dateKey;
        }
        renderEntries();
      });
      grid.appendChild(cell);
    }
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

  function getDominantMoodColorForDate(dateString) {
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

  function updateWordCloud() {
    const cloud = document.getElementById('wordCloud');
    if (!cloud) return;
    cloud.innerHTML = '';
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
      const size = 1 + (count / maxCount) * 2;
      span.style.fontSize = size + 'rem';
      span.style.color = colors[Math.floor(Math.random() * colors.length)];
      span.style.top = Math.random() * 80 + '%';
      span.style.left = Math.random() * 80 + '%';
      span.style.transform = `rotate(${(Math.random() * 30 - 15).toFixed(2)}deg)`;
      cloud.appendChild(span);
    });
  }

  function loadColorTheme() {
    const saved = localStorage.getItem('m2mColorTheme') || 'default';
    document.body.classList.remove('theme-neon', 'theme-sunset');
    if (saved === 'neon') {
      document.body.classList.add('theme-neon');
    } else if (saved === 'sunset') {
      document.body.classList.add('theme-sunset');
    }
    const buttons = document.querySelectorAll('#themePicker .theme-btn');
    buttons.forEach(btn => {
      btn.classList.remove('active');
      if (btn.getAttribute('data-theme') === saved) {
        btn.classList.add('active');
      }
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    const themeButtons = document.querySelectorAll('#themePicker .theme-btn');
    themeButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        const theme = btn.getAttribute('data-theme');
        localStorage.setItem('m2mColorTheme', theme);
        loadColorTheme();
      });
    });
  });

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
    // Celebration effects disabled.
    entryForm.reset();
  });

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

  const newAffirmationBtn = document.getElementById('newAffirmationBtn');
  if (newAffirmationBtn) {
    newAffirmationBtn.addEventListener('click', () => {
      loadDailyAffirmation();
    });
  }

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

  function loadTheme() {
    const saved = localStorage.getItem('m2mTheme');
    if (saved === 'dark') {
      document.body.classList.add('dark');
      themeToggle.textContent = '☀️';
      loadColorTheme();
    }
  }

  chatToggle.addEventListener('click', () => {
    chatWindow.classList.add('open');
    chatToggle.style.display = 'none';
  });
  chatCloseBtn.addEventListener('click', () => {
    chatWindow.classList.remove('open');
    chatToggle.style.display = 'flex';
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

  chatExpandBtn.addEventListener('click', () => {
    if (!chatWindow) return;
    const expanded = chatWindow.getAttribute('data-expanded') === 'true';
    if (expanded) {
      chatWindow.style.width = '';
      chatWindow.style.height = '';
      chatWindow.style.left = '';
      chatWindow.style.top = '';
      chatWindow.style.right = '20px';
      chatWindow.style.bottom = '80px';
      chatWindow.style.transform = '';
      chatWindow.setAttribute('data-expanded', 'false');
      chatExpandBtn.textContent = '⛶';
    } else {
      chatWindow.style.width = '90vw';
      chatWindow.style.height = '70vh';
      chatWindow.style.left = '';
      chatWindow.style.bottom = '';
      chatWindow.style.right = '20px';
      chatWindow.style.top = '10vh';
      chatWindow.style.transform = '';
      chatWindow.setAttribute('data-expanded', 'true');
      chatExpandBtn.textContent = '🗗';
    }
  });

  chatForm.addEventListener('submit', async event => {
    event.preventDefault();
    const message = chatInput.value.trim();
    if (!message) return;
    appendMessage(message, 'user');
    chatInput.value = '';
    await sendChatMessage(message);
  });

  function appendMessage(text, author) {
    const msg = document.createElement('div');
    msg.className = `message ${author}`;
    let html = text;
    html = html
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\n/g, '<br>');
    msg.innerHTML = html;
    chatMessages.appendChild(msg);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  async function sendChatMessage(userMessage) {
    conversationHistory.push({ role: 'user', content: userMessage });
    try {
      const apiKey = await getApiKey();
      if (!apiKey) {
        appendMessage('Error: No Gemini API key provided. Please refresh and enter a valid key to use the chatbot.', 'bot');
        return;
      }
      const modelName = 'gemini-2.5-flash';
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`;
      const recent = getRecentMoodsForAffirmation(5);
      let contextPrompt;
      if (recent && recent.length > 0) {
        const unique = Array.from(new Set(recent));
        contextPrompt = `You are a friendly domain-specific journaling assistant. The user has recently logged the moods: ${unique.join(', ')}. Use these moods as cues to discuss their day, reflect positively on their emotions, and offer gentle suggestions for turning tough or overwhelmed feelings into meaningful actions. In your replies, help the user find more meaning and purpose in their life by encouraging self-discovery and intentional growth. Provide empathy, encouragement and constructive reflection without explicitly listing the moods.`;
      } else {
        contextPrompt = 'You are a friendly journaling assistant. The user seeks supportive, reflective guidance. Provide empathetic responses that encourage positive self-reflection, help them find meaning and purpose, and transform challenges into constructive actions.';
      }
      const contents = [];
      contents.push({
        role: 'user',
        parts: [{ text: contextPrompt }]
      });
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
          'X-Goog-Api-Key': apiKey
        },
        body: JSON.stringify(payload)
      });
      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }
      const data = await response.json();
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
