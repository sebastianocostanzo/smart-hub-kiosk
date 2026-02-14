/* ================== SMART HUB v87 (Direct Logic + Instant UI) ================== */
const CONFIG = {
    SIMULATION: false, 
    TRAVEL_TIME: 20000, 
    GEMINI_KEY: "AIzaSyCjxNWIEhk11l5SvsmXq-OYgWMStGrZ_bc",
    BRIDGE_URL: "https://script.google.com/macros/s/AKfycbxzSWDfAiOOxyzQLMYdwOPAxAak-HEBGCstUARUDVQkWt9qSTqXvjCBr7-8q3qkKfQ7/exec",
    IPS: { 
        kid: '192.168.86.203',     // Old 'k' (Karolina)
        master: '192.168.86.22',  // Old 'm'
        tv_area: '192.168.86.20', // Old 'rr' (Dining/TV)
        sofa: '192.168.86.21'     // Old 'll' (Living)
    },
    TV_IP: '192.168.86.154', 
    COORDS: { lat: 51.066, lng: 16.925 }
};

const State = {
    systemLocked: true, 
    isListening: false,
    coverStatus: {}, 
    // Default to 0 (Closed) if no memory to prevent "Ghost Open" state
    positions: JSON.parse(localStorage.getItem('smart_hub_pos')) || { kid: 0, master: 0, tv_area: 0, sofa: 0},
    coverTimers: {},
    photos: [], photoIndex: 0, slideIdx: 1
};

const App = {
    log: (msg, type="") => { 
        const box=document.getElementById('debug-log'); 
        if(box) { 
            box.innerHTML = `<div class="${type}">[${new Date().toLocaleTimeString()}] ${msg}</div>` + box.innerHTML;
        } 
        console.log(msg); 
    },

    syncHardware: () => {
        console.log("Starting Hardware Sync...");
        
        // The new keys corresponding to your updated CONFIG.IPS
        const rooms = ['kid', 'master', 'tv_area', 'sofa'];

        rooms.forEach(room => {
            const ip = CONFIG.IPS[room];
            if (!ip) return; // Skip if IP is missing

            // Create a 2-second timeout so one offline device doesn't freeze the app
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 2000);

            // Call Shelly Gen 2 API
            fetch(`http://${ip}/rpc/Cover.GetStatus?id=0`, { signal: controller.signal })
                .then(r => r.json())
                .then(data => {
                    // Gen 2 devices return 'pos' (or 'current_pos' in some firmwares)
                    // We check both to be safe.
                    const realPos = (data.current_pos !== undefined) ? data.current_pos : data.pos;
                    
                    if (realPos !== undefined) {
                        // 1. Update Internal State
                        State.positions[room] = realPos;
                        
                        // 2. Update UI (Progress Bar)
                        const bar = document.getElementById(`prog-${room}`);
                        if (bar) {
                            bar.style.width = `${realPos}%`;
                        }
                        
                        // 3. Update Button State (Optional: Highlight active buttons)
                        // This helps if you have "Open/Close" active states
                    }
                })
                .catch(e => {
                    // It is normal for this to fail if a device is offline
                    // We use console.debug to avoid cluttering the main log
                    console.debug(`Sync failed for ${room} (${ip}) - Device might be offline.`);
                });
        });
    },
    
    feedback: (msg) => { const el=document.getElementById('ai-feedback'); el.innerText=msg; el.style.opacity=msg?1:0; },
    
    send: (url) => { if(CONFIG.SIMULATION) App.log(`📡 SIM: ${url}`,"log-sim"); else fetch(url,{mode:'no-cors'}).catch(e=>App.log("Net Error:"+e)); },
    
    saveState: () => { localStorage.setItem('smart_hub_pos', JSON.stringify(State.positions)); },

    unlock: () => { State.systemLocked = false; App.log("✅ SYSTEM UNLOCKED"); App.feedback(""); },
    checkLock: () => { if(State.systemLocked) { App.feedback("⛔ LOCKED"); return true; } return false; },

    // --- TOUCH SEEK LOGIC (ALIGNED) ---
    setupSeekbars: () => {
        Object.keys(CONFIG.IPS).forEach(id => {
            const wrap = document.querySelector(`#prog-${id}`).parentElement;
            if(wrap) {
                const newWrap = wrap.cloneNode(true);
                wrap.parentNode.replaceChild(newWrap, wrap);
                
                newWrap.addEventListener('click', (e) => {
                    if(App.checkLock()) return;
                    const rect = newWrap.getBoundingClientRect();
                    // 0 at bottom, 100 at top
                    const clickY = rect.bottom - e.clientY;
                    let percentage = Math.round((clickY / rect.height) * 100);
                    
                    if(percentage < 0) percentage = 0;
                    if(percentage > 100) percentage = 100;
                    
                    App.seek(id, percentage);
                });
            }
        });
    },

    seek: (id, targetPos) => {
        const currentPos = State.positions[id] || 0;
        if(!State.coverStatus[id]) {
            State.coverStatus[id] = (targetPos > currentPos) ? 'Open' : 'Close';
        }

        const duration = (Math.abs(targetPos - currentPos) / 100) * CONFIG.TRAVEL_TIME;
        App.log(`🎬 Seek: ${id} to ${targetPos}% in ${duration}ms`);
        
        App.animateBar(id, targetPos, duration);
        App.send(`http://${CONFIG.IPS[id]}/rpc/Cover.GoToPosition?id=0&pos=${targetPos}`);

        if(State.coverTimers[id]) clearTimeout(State.coverTimers[id]);
        State.coverTimers[id] = setTimeout(() => {
            App.log(`🏁 Timer End for ${id}`);
            State.coverStatus[id] = null;
            State.positions[id] = targetPos;
            App.updateCoverUI(id);
        }, duration);
    },

    animateBar: (id, targetPos, durationMs) => {
        const progressBar = document.getElementById(`prog-${id}`);
        if(progressBar) {
            // Start the CSS transition
            progressBar.style.transition = `height ${durationMs}ms linear`;
            progressBar.style.height = `${targetPos}%`;
        }
        
        // CRITICAL: Force the moving flag to true
        App.updateButtonState(id, targetPos, true); 
    },
    
    updateButtonState: (id, pos, moving) => {
        const btnOpen = document.getElementById(`btn-${id}-open`);
        const btnClose = document.getElementById(`btn-${id}-close`);
        const progressBar = document.getElementById(`prog-${id}`);
        
        if (!btnOpen || !btnClose) return;

        // The "Source of Truth" is now the State object, not the progressBar height
        const status = State.coverStatus[id];
        
        // Logic: Show pause if the app says it's moving and we have a direction
        const activeMoving = moving && !!status;

        // DEBUG: Track why the icon is choosing its shape
        App.log(`🔍 [${id}] Icon Check -> ActiveMoving: ${activeMoving} | Status: ${status} | Target: ${pos}%`);

        if (activeMoving) {
            btnOpen.innerHTML = (status === 'Open') ? "⏸" : "▲";
            btnClose.innerHTML = (status === 'Close') ? "⏸" : "▼";
        } else {
            btnOpen.innerHTML = "▲"; 
            btnClose.innerHTML = "▼";
        }

        // Disabled states: If we aren't moving, disable buttons at the limits
        btnOpen.disabled = (pos >= 98 && !activeMoving);
        btnClose.disabled = (pos <= 2 && !activeMoving);

        // While moving, prevent clicking the opposite direction button
        if (activeMoving) {
            if (status === 'Open') btnClose.disabled = true;
            if (status === 'Close') btnOpen.disabled = true;
        }
    },

    resetSystem: () => {
        ['k', 'm', 'rr', 'll'].forEach(id => {
            State.coverStatus[id] = null; 
            if(State.coverTimers[id]) clearTimeout(State.coverTimers[id]);
            const p = document.getElementById(`prog-${id}`);
            if(p) p.style.transition = 'none';
            App.updateCoverUI(id);        
        });
    },

    cover: (room, action) => {
        // 1. Security Check
        if (State.systemLocked) {
            console.warn("System Locked: Command ignored.");
            return;
        }

        const ip = CONFIG.IPS[room];
        if (!ip) return console.error(`Unknown Room ID: ${room}`);

        // 2. Logic: Define Position vs Stop
        let method = "Cover.GoToPosition";
        let params = { id: 0 };
        let targetPos = null;

        if (action === 'Open') {
            targetPos = 100;
            params.pos = 100;
        } else if (action === 'Close') {
            targetPos = 0;
            params.pos = 0;
        } else if (action === 'Stop') {
            method = "Cover.Stop";
            // No pos needed for stop
        } else {
            // Handle numeric percentage commands if you have them later
            targetPos = parseInt(action);
            params.pos = targetPos;
        }

        // 3. OPTIMISTIC UPDATE (Fixes T4)
        // We update the state immediately so the UI feels instant
        // and the Test Suite knows the command was accepted.
        if (targetPos !== null) {
            State.positions[room] = targetPos;
            App.updateCoverUI(room); // Updates the progress bar width
            
            // Persist to storage
            localStorage.setItem('smart_hub_pos', JSON.stringify(State.positions));
        }

        // 4. NETWORK COMMAND (Fixes T2)
        const payload = { method: method, params: params };
        console.log(`Sending ${room}:`, payload); // Debug

        fetch(`http://${ip}/rpc`, {
            method: 'POST',
            body: JSON.stringify(payload)
        }).catch(e => console.error("Hardware Error:", e));
    },
    
    updateCoverUI: (id) => {
        const currentPos = State.positions[id] || 0; 
        const progressBar = document.getElementById(`prog-${id}`);
        
        if (progressBar && (progressBar.style.transition === 'none' || progressBar.style.transition === '')) {
            progressBar.style.height = `${currentPos}%`;
        }
        
        // Pass the specific ID so only those buttons are updated
        App.updateButtonState(id, currentPos, !!State.coverStatus[id]);
    },

    tv: (s,m,p) => { if(App.checkLock()) return; fetch(`http://${CONFIG.TV_IP}/sony/${s}`,{method:'POST',headers:{'X-Auth-PSK':'1234'},body:JSON.stringify({method:m,id:1,params:p,version:"1.0"})}).catch(e=>App.log("TV Err:"+e)); },
    
    triggerVoice: () => {
        if(App.checkLock()) return; if(State.isListening) return;
        State.isListening=true; document.getElementById('mic-btn').classList.add('listening'); App.feedback("Listening...");
        const R=window.webkitSpeechRecognition||window.SpeechRecognition;
        if(!R) return App.log("No Speech API");
        const r=new R(); r.lang='en-US'; r.continuous=false;
        r.onresult=(e)=>{ const t=e.results[0][0].transcript.toLowerCase(); App.processCommand(t); };
        r.onerror=()=>App.stopVoice(); r.onend=()=>App.stopVoice(); r.start();
    },
    stopVoice: () => { State.isListening=false; document.getElementById('mic-btn').classList.remove('listening'); App.feedback(""); },
    
processCommand: async (text) => {
        if (App.checkLock()) return;

        App.log(`👂 Heard: "${text}"`);
        const cleanText = text.toLowerCase();
        
        // The Source of Truth for Room IDs
        const rooms = ['kid', 'master', 'tv_area', 'sofa'];

        // --- 1. MACROS (Fast Logic) ---
        
        if (cleanText.includes("morning")) { 
            App.speak("Good morning. Opening the house."); 
            // Now opens ALL rooms including Master
            rooms.forEach(id => App.cover(id, 'Open')); 
            return; 
        }

        if (cleanText.includes("night")) { 
            App.speak("Good night."); 
            // Closes ALL rooms
            rooms.forEach(id => App.cover(id, 'Close')); 
            App.tv('system', 'setPowerStatus', [{status: false}]); 
            return; 
        }

        // --- 2. SPECIFIC OVERRIDES (Optional) ---
        // Maps "kitchen" or "karolina" voice commands to the 'kid' room
        if ((cleanText.includes("kitchen") || cleanText.includes("karolina")) && cleanText.includes("open")) { 
            App.cover('kid', 'Open'); 
            App.speak("Opening Karolina's room"); 
            return; 
        }
        if ((cleanText.includes("kitchen") || cleanText.includes("karolina")) && cleanText.includes("close")) { 
            App.cover('kid', 'Close'); 
            App.speak("Closing Karolina's room"); 
            return; 
        }
        
        // --- 3. AI REASONING (Smart Logic) ---
        App.feedback("Thinking...");
        try {
            // Using standard 1.5 Flash model
            const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${CONFIG.GEMINI_KEY}`;
            
            // We update the system prompt to teach Gemini the NEW room names
            const systemPrompt = `
                User:"${text}". 
                Current State: ${JSON.stringify(State.positions)}.
                Tools: COVERS[kid, master, tv_area, sofa], TV. 
                Rule: Return strictly valid JSON. 
                Example: {"actions":[{"id":"kid","tool":"cover","action":"Open"}],"response":"Opening Karolina's blind"}
            `;

            const res = await fetch(url, { 
                method: 'POST', 
                headers: {'Content-Type': 'application/json'}, 
                body: JSON.stringify({ 
                    contents: [{ parts: [{ text: systemPrompt }] }] 
                }) 
            });

            const json = await res.json();
            
            // Parse response
            const candidate = json.candidates[0].content.parts[0].text;
            const data = JSON.parse(candidate.replace(/```json|```/g, ''));
            
            App.speak(data.response);
            
            // Execute Actions
            if (data.actions) {
                data.actions.forEach(a => { 
                    if (a.tool === 'cover') App.cover(a.id, a.action); 
                    if (a.tool === 'tv') App.tv('audio', 'setAudioVolume', [{target: 'speaker', volume: '+3'}]); 
                });
            }
        } catch (e) { 
            console.error(e);
            App.log("AI Error"); 
            App.feedback("AI Error"); 
        }
    },
    
    speak: (text) => { if(!('speechSynthesis' in window)) return; window.speechSynthesis.cancel(); const msg = new SpeechSynthesisUtterance(text); window.speechSynthesis.speak(msg); },
    
    loadPhotos: async () => { try { const res=await fetch(CONFIG.BRIDGE_URL+`?cb=${Date.now()}`); const data=await res.json(); if(data.length){ State.photos=data.sort(()=>Math.random()-0.5); App.nextSlide(); } } catch(e){} },
    nextSlide: () => {
        if(!State.photos.length) return;
        const item=State.photos[State.photoIndex]; const url=item.url.replace(/sz=[^&]+/,"sz=s0");
        const next=State.slideIdx===1?2:1; const img=new Image();
        img.onload=()=>{
            document.getElementById(`blur-${next}`).style.backgroundImage=`url('${url}')`;
            document.getElementById(`sharp-${next}`).style.backgroundImage=`url('${url}')`;
            document.getElementById(`slide-${next}`).classList.add('active');
            document.getElementById(`slide-${State.slideIdx}`).classList.remove('active');
            const cityName = localStorage.getItem(`geo_${item.latitude}_${item.longitude}`) || item.folderName || "";
            document.getElementById('photo-desc').innerText=cityName.toUpperCase();
            document.getElementById('super-widget').classList.add('visible');
            State.slideIdx=next; State.photoIndex=(State.photoIndex+1)%State.photos.length;
        }; img.src=url;
    },
    updateWeather: async () => { try { const res=await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${CONFIG.COORDS.lat}&longitude=${CONFIG.COORDS.lng}&current_weather=true`); const d=await res.json(); document.getElementById('temp').innerText=Math.round(d.current_weather.temperature)+"°"; } catch(e){} }
};

window.App=App;
window.toggleDebug=()=>{const d=document.getElementById('debug-log');d.style.display=(d.style.display==='none'?'block':'none');};
window.toggleDrawer=()=>{const d=document.getElementById('control-drawer');d.classList.toggle('hidden');document.getElementById('drawer-toggle').innerText=d.classList.contains('hidden')?"▶":"◀";};
if(window.fully) window.fully.bind('onMotion','App.triggerVoice();');

// BOOT SEQUENCE
window.addEventListener('load', () => {
    // 1. SETUP UI HANDLERS
    App.setupSeekbars();

    // 2. IMMEDIATE STATE REFRESH (Visuals)
    ['k', 'm', 'rr', 'll'].forEach(id => App.updateCoverUI(id));

    // 3. HARDWARE SYNC (Logic)
    // Small 500ms delay to allow DOM to breathe, but fast enough to feel "instant"
    setTimeout(() => {
        App.syncHardware();
        setInterval(() => { if(!State.systemLocked) App.syncHardware(); }, 30000); 
    }, 500);

    App.loadPhotos(); 
    App.updateWeather();

    // ADD THIS LINE to open the drawer on boot:
    App.syncHardware(); // Ensure we have latest data
    //window.toggleDrawer();
    
    setInterval(App.nextSlide, 15000); 
    setInterval(App.updateWeather, 900000);
    setInterval(() => {
        const clk = document.getElementById('widget-clock');
        if(clk) clk.innerText = new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
    }, 1000);
});

window.addEventListener('click', () => { App.speak(""); }, {once:true});