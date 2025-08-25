// simulation.js (Corrected)
// A full game simulation of the bot playing against itself.

async function runSimulation() {
    console.log("======================================");
    console.log("  Bot vs. Bot Full Game Simulation  ");
    console.log("======================================\n");

    // **THE FIX IS HERE**: Importing all the necessary functions
    const botModule = await import('./gridora_bot7.js');
    const { state, findBestSingleMove, scoreGrid, gridToString } = botModule;

    // --- SETUP THE GAME ---
    const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
    const suits = ['h', 'd', 'c', 's'];
    let fullDeck = [];
    for (const suit of suits) {
        for (const rank of ranks) {
            fullDeck.push(rank + suit);
        }
    }

    for (let i = fullDeck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [fullDeck[i], fullDeck[j]] = [fullDeck[j], fullDeck[i]];
    }

    const simState = {
        deck: fullDeck,
        community: fullDeck.splice(0, 7),
        grid1: Array.from({ length: 5 }, () => Array(5).fill(null)),
        grid2: Array.from({ length: 5 }, () => Array(5).fill(null)),
        placed1: 0,
        placed2: 0,
    };

    let turn = 1;

    // --- RUN THE GAME LOOP ---
    while (simState.placed1 < 25 || simState.placed2 < 25) {
        const isPlayer1Turn = turn % 2 !== 0;
        const cardsToPlace = (simState.placed1 >= 24 && simState.placed2 >= 24) ? 1 : 2;

        for (let i = 0; i < cardsToPlace; i++) {
            if ((isPlayer1Turn && simState.placed1 >= 25) || (!isPlayer1Turn && simState.placed2 >= 25)) continue;

            state.myGrid = isPlayer1Turn ? simState.grid1 : simState.grid2;
            state.oppGrid = isPlayer1Turn ? simState.grid2 : simState.grid1;
            state.community = simState.community;
            
            const move = findBestSingleMove();
            if (!move) break;

            const currentGrid = isPlayer1Turn ? simState.grid1 : simState.grid2;
            currentGrid[move.row][move.col] = move.card;
            
            if (isPlayer1Turn) simState.placed1++; else simState.placed2++;
            simState.community = simState.community.filter(c => c !== move.card);
        }
        
        const cardsToDraw = Math.min(cardsToPlace, simState.deck.length);
        for (let i = 0; i < cardsToDraw; i++) {
            if (simState.deck.length > 0) simState.community.push(simState.deck.shift());
        }
        turn++;
    }

    // --- DISPLAY FINAL RESULTS ---
    const score1 = scoreGrid(simState.grid1);
    const score2 = scoreGrid(simState.grid2);

    console.log("--- FINAL BOARDS ---");
    console.log(`\nPlayer 1 Score: ${score1}`);
    console.log(gridToString(simState.grid1));
    
    console.log(`\nPlayer 2 Score: ${score2}`);
    console.log(gridToString(simState.grid2));

    console.log("\n--- RESULT ---");
    if (score1 > score2) console.log("Player 1 Wins!");
    else if (score2 > score1) console.log("Player 2 Wins!");
    else console.log("It's a Draw!");
    console.log("======================================");
}

runSimulation().catch(err => console.error(err));