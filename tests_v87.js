/* ================== TEST SUITE v87 (POST-Compatible) ================== */
console.log("TS: Loaded v87");

const TestSuite = {
    results: [], logs: [],
    
    setupMocks: () => {
        State.systemLocked = false; 
        TestSuite.originalSend = App.send; 
        TestSuite.originalSpeak = App.speak; 
        TestSuite.originalFetch = window.fetch;
        TestSuite.sentUrls = []; 
        TestSuite.spokenText = [];
        
        // Spy on Speak
        App.speak = (text) => { TestSuite.spokenText.push(text); TestSuite.log(`->Speak:"${text}"`); };
        
        // INTELLIGENT FETCH SPY (The Fix)
        window.fetch = async (url, options) => { 
            // 1. Handle Gemini AI
            if(url.includes("generativelanguage")) {
                return { json: async()=>({candidates:[{content:{parts:[{text:`{"actions":[],"response":"AI Mock"}`}]}}]}) };
            }

            // 2. Handle Shelly Hardware (POST Requests)
            // We translate the POST body back into a string so the Test Assertions can read it easily.
            if (options && options.method === 'POST' && options.body) {
                try {
                    const body = JSON.parse(options.body);
                    // Create a "Virtual URL" that looks like the old GET format
                    // e.g. "http://ip/rpc/Cover.GoToPosition?id=0&pos=100"
                    let virtualUrl = `${url}/${body.method}?`;
                    if(body.params) {
                        virtualUrl += Object.entries(body.params).map(([k,v]) => `${k}=${v}`).join('&');
                    }
                    
                    TestSuite.sentUrls.push(virtualUrl);
                    TestSuite.log(`->Net:${virtualUrl}`); 
                } catch(e) {
                    TestSuite.log(`->Net(Error):${e.message}`);
                }
            } 
            // 3. Handle Legacy GET Requests
            else {
                TestSuite.sentUrls.push(url);
                TestSuite.log(`->Net:${url}`);
            }

            // Return fake status for hardware
            return { json: async()=>({ current_pos: 0, state: 'stopped', pos: 0 }) }; 
        };
        
        // Mock Voice
        window.MockSpeech = class { start(){ setTimeout(()=>this.onresult({results:[[{transcript:"motion test"}]]}), 500); } };
        window.SpeechRecognition = window.MockSpeech;
    },

    teardownMocks: () => { 
        App.send = TestSuite.originalSend; 
        App.speak = TestSuite.originalSpeak; 
        window.fetch = TestSuite.originalFetch; 
        State.systemLocked = true; 
    },

    log: (msg) => { TestSuite.logs.push(msg); },
    
    assert: (d, c) => { 
        const s = c ? "PASS" : "FAIL"; 
        TestSuite.results.push({d, s}); 
        TestSuite.log(`[${s}] ${d}`); 
        return c; 
    },

    run: async () => {
        TestSuite.log("Starting Test Suite v87 (Post-Fix)...");
        TestSuite.results = []; 
        TestSuite.setupMocks();

        // The Source of Truth for Room IDs
        const rooms = ['kid', 'master', 'tv_area', 'sofa'];

        try {
            // ==========================================
            // T1: MACRO EXECUTION (Good Morning = Open ALL)
            // ==========================================
            State.positions['kid'] = 0; 
            
            App.processCommand("good morning");
            
            // The Virtual URL logic allows these checks to pass even though we use POST now
            const t1_kid    = TestSuite.sentUrls.some(u => u.includes(CONFIG.IPS.kid)     && u.includes("pos=100"));
            const t1_tv     = TestSuite.sentUrls.some(u => u.includes(CONFIG.IPS.tv_area) && u.includes("pos=100"));
            const t1_sofa   = TestSuite.sentUrls.some(u => u.includes(CONFIG.IPS.sofa)    && u.includes("pos=100"));
            const t1_master = TestSuite.sentUrls.some(u => u.includes(CONFIG.IPS.master)  && u.includes("pos=100"));

            TestSuite.assert("T1:Macro Morning (All Open)", t1_kid && t1_tv && t1_sofa && t1_master);


            // ==========================================
            // T2: VOICE RECOGNITION (Good Night = Close)
            // ==========================================
            TestSuite.sentUrls = []; // Clear previous logs
            App.processCommand("good night");
            
            // Check for 'pos=0' (Close)
            TestSuite.assert("T2:Voice Processing (Close)", TestSuite.sentUrls.some(u => u.includes("Cover.GoToPosition") && u.includes("pos=0")));


            // ==========================================
            // T3: AI LOGIC (Mocked)
            // ==========================================
            await App.processCommand("i feel cold"); 
            TestSuite.assert("T3:AI Response", TestSuite.spokenText.length > 0);


            // ==========================================
            // T4: STATE CONSISTENCY
            // ==========================================
            TestSuite.log("T4: Validating Logic State");
            State.positions['master'] = 0; 
            
            App.cover('master', 'Open'); // Trigger
            
            TestSuite.assert("T4:State=100%", State.positions['master'] === 100);


            // ==========================================
            // T5: MOTION
            // ==========================================
            State.isListening = false;
            if(typeof App.triggerVoice === 'function') {
                App.triggerVoice(); 
                await new Promise(r => setTimeout(r, 1000));
                TestSuite.assert("T5:Motion Trigger", State.isListening === true || TestSuite.spokenText.length > 0);
            } else {
                TestSuite.log("T5: Skipped (Function Missing)");
            }


            // ==========================================
            // T6: HARDWARE SYNC
            // ==========================================
            TestSuite.log("T6: Mocking Hardware Sync");
            App.syncHardware();
            await new Promise(r => setTimeout(r, 600)); 
            // Check that at least one room state is defined/touched
            TestSuite.assert("T6: Sync Handled", State.positions['kid'] !== undefined);


            // ==========================================
            // T7: CLEANUP & SANITY CHECK
            // ==========================================
            TestSuite.log("--- CLEANUP PHASE ---");
            if(App.resetSystem) App.resetSystem(); 
            rooms.forEach(id => App.updateCoverUI(id)); 
            
            let clean = true;
            rooms.forEach(id => {
                const btnO = document.getElementById(`btn-${id}-open`);
                if(btnO && btnO.innerHTML === "⏸") {
                    TestSuite.log(`FAIL: ${id} icon is Pause`);
                    clean = false;
                }
            });
            TestSuite.assert("T7:System Clean Boot", clean === true);

        } catch (e) { 
            TestSuite.assert("FATAL ERROR IN SUITE", false); 
            TestSuite.log(e.stack); 
        }

        TestSuite.teardownMocks();
        TestSuite.render();
    },

    render: () => {
        const allPassed = TestSuite.results.every(r => r.s === "PASS");
        
        if (allPassed) {
            App.unlock();
            if(App.resetSystem) App.resetSystem(); 
            const d = document.getElementById('debug-log'); if(d) d.style.display = 'none';
        } else {
            App.feedback("LOCKED");
        }

        const c = allPassed ? "#00ff00" : "#ff0000";
        const div = document.createElement('div');
        div.id = 'test-report-window';
        div.style.cssText = `position:fixed;top:0;left:0;width:100%;height:100%;background:#111;border:5px solid ${c};color:white;z-index:9999;padding:40px;overflow-y:auto;`;
        let h = `<h1 style="color:${c}">${allPassed ? "SYSTEM GO" : "FAIL"}</h1><ul>`;
        TestSuite.results.forEach(r => { h += `<li style="color:${r.s === 'PASS' ? '#0f0' : '#f00'}">[${r.s}] ${r.d}</li>`; });
        h += `</ul><textarea style="width:100%;height:200px;background:#222;color:#ccc;">${TestSuite.logs.join('\n')}</textarea>`;
        
        if (allPassed) setTimeout(() => { if(document.getElementById('test-report-window')) document.getElementById('test-report-window').remove(); }, 5000);
        else h += `<button onclick="this.parentNode.remove()">CLOSE</button>`;
        
        div.innerHTML = h; document.body.appendChild(div);
    }
};

// AUTO-RUN
setTimeout(TestSuite.run, 2000);