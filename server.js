// --- Server Setup ---
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = process.env.PORT || 3000;
const STARTING_CHIPS = 2000;
const SMALL_BLIND = 10;
const BIG_BLIND = 20;

app.use(express.static(path.join(__dirname, 'Public')));

// --- Game Logic and State ---
let channels = {};

// --- Hand Evaluation Constants ---
const HAND_RANKS = { HIGH_CARD: 0, PAIR: 1, TWO_PAIR: 2, THREE_OF_A_KIND: 3, STRAIGHT: 4, FLUSH: 5, FULL_HOUSE: 6, FOUR_OF_A_KIND: 7, STRAIGHT_FLUSH: 8, FIVE_OF_A_KIND: 9 };
const HAND_NAMES = Object.keys(HAND_RANKS).reduce((obj, key) => { obj[HAND_RANKS[key]] = key.replace(/_/g, ' '); return obj; }, {});
const valueMap = "23456789TJQKA".split('').reduce((map, value, i) => { map[value] = i + 2; return map; }, {});


// --- Game Functions ---
function createDeck(deckCount = 1) {
    const suits = ['♥', '♦', '♣', '♠'];
    const values = "23456789TJQKA".split('');
    let deck = [];
    for (let i = 0; i < deckCount; i++) {
        for (const suit of suits) {
            for (const value of values) {
                deck.push({ suit, value, rank: valueMap[value] });
            }
        }
    }
    return deck;
}

function shuffleDeck(deck) {
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
}

function initializeGame(channelId, settings) {
    const channel = channels[channelId];
    if (!channel) return;
    const { gameState, players } = channel;

    gameState.settings = settings;
    gameState.deck = createDeck(settings.deckCount);
    shuffleDeck(gameState.deck);
    gameState.isGameStarted = true;
    gameState.currentStage = 0;
    gameState.currentSmallBlind = SMALL_BLIND;
    gameState.currentBigBlind = BIG_BLIND;
    gameState.roundsPlayedSinceIncrease = 0;
    
    gameState.communityCards = Array.from({ length: settings.numBoards }, () => []);
    gameState.winners = Array.from({ length: settings.numBoards }, () => []);
    gameState.pot = Array.from({ length: settings.numBoards }, () => 0);
    gameState.currentBets = Array.from({ length: settings.numBoards }, () => 0);

    Object.values(players).forEach(player => {
        if (player.chips === undefined) player.chips = STARTING_CHIPS;
        if (player.sessionStartChips === undefined) player.sessionStartChips = player.chips;
        player.hand = gameState.deck.splice(0, settings.numPlayerCards);
        player.isFolded = Array(settings.numBoards).fill(false);
        player.currentBets = Array(settings.numBoards).fill(0);
        player.hasActed = false;
    });

    startBettingRound(channelId, true);
}

function startBettingRound(channelId, postBlinds = false) {
    const channel = channels[channelId];
    if (!channel) return;
    const { gameState, players } = channel;
    
    gameState.currentBets = Array(gameState.settings.numBoards).fill(0);
    
    Object.values(players).forEach(p => {
        p.currentBets = Array(gameState.settings.numBoards).fill(0);
        p.hasActed = false;
    });
    
    gameState.activePlayerIds = Object.keys(players).filter(pid => players[pid].chips > 0);
    
    const playerIds = gameState.activePlayerIds;
    const numPlayers = playerIds.length;
    if (numPlayers < 2) return;

    const dealerIndex = playerIds.findIndex(pid => pid === gameState.dealerId);
    let firstToActIndex;

    if (postBlinds) {
        // Blinds only go into the first pot
        const sbPlayerId = playerIds[numPlayers === 2 ? dealerIndex : (dealerIndex + 1) % numPlayers];
        const bbPlayerId = playerIds[numPlayers === 2 ? (dealerIndex + 1) % numPlayers : (dealerIndex + 2) % numPlayers];
        
        const sbPlayer = players[sbPlayerId];
        if (sbPlayer) {
            const blindAmount = Math.min(gameState.currentSmallBlind, sbPlayer.chips);
            sbPlayer.chips -= blindAmount;
            sbPlayer.currentBets[0] = blindAmount;
            gameState.pot[0] += blindAmount;
        }

        const bbPlayer = players[bbPlayerId];
        if (bbPlayer) {
            const blindAmount = Math.min(gameState.currentBigBlind, bbPlayer.chips);
            bbPlayer.chips -= blindAmount;
            bbPlayer.currentBets[0] = blindAmount;
            gameState.pot[0] += blindAmount;
        }
        gameState.currentBets[0] = gameState.currentBigBlind;
        firstToActIndex = (playerIds.indexOf(bbPlayerId) + 1) % numPlayers;
    } else {
        firstToActIndex = (dealerIndex + 1) % numPlayers;
        if(firstToActIndex >= playerIds.length) firstToActIndex = 0;
    }
    
    gameState.turnId = playerIds[firstToActIndex];
}

// --- Socket.IO Connection Handling ---
io.on('connection', (socket) => {
    // ... connection and channel management logic ...
    socket.on('playerAction', (action) => {
        const channelId = socket.data.channelId;
        handlePlayerAction(channelId, socket.id, action);
    });
    // ... other listeners ...
});

function handlePlayerAction(channelId, playerId, action) {
    const channel = channels[channelId];
    if (!channel || playerId !== channel.gameState.turnId || !channel.gameState.isGameStarted) return;
        
    const player = channel.players[playerId];
    const { type, boardIndex, amount } = action;

    if (type === 'fold') {
        player.isFolded[boardIndex] = true;
    } else if (type === 'check') {
        if (channel.gameState.currentBets[boardIndex] > player.currentBets[boardIndex]) return;
    } else if (type === 'call') {
        const callAmount = Math.min(player.chips, channel.gameState.currentBets[boardIndex] - player.currentBets[boardIndex]);
        player.chips -= callAmount;
        player.currentBets[boardIndex] += callAmount;
        channel.gameState.pot[boardIndex] += callAmount;
    } else if (type === 'raise') {
        if (amount % 25 !== 0 || amount < 0) return;
        const totalBet = channel.gameState.currentBets[boardIndex] + amount;
        const amountToRaise = totalBet - player.currentBets[boardIndex];
        if (player.chips >= amountToRaise) {
            player.chips -= amountToRaise;
            player.currentBets[boardIndex] += amountToRaise;
            channel.gameState.pot[boardIndex] += amountToRaise;
            channel.gameState.currentBets[boardIndex] = player.currentBets[boardIndex];
            // Reset hasActed for other players on THIS board
            Object.values(channel.players).forEach(p => {
                if(p.id !== playerId && !p.isFolded[boardIndex]) {
                    p.hasActed = false; // This is tricky, turn needs to be managed carefully now
                }
            });
        }
    }
    
    player.hasActed = true; // Mark player as having acted in their turn
    advanceTurn(channelId);
    io.to(channelId).emit('stateUpdate', channel);
}

function advanceTurn(channelId) {
    const channel = channels[channelId];
    if (!channel) return;
    const { gameState, players, settings } = channel;

    const allActivePlayers = Object.values(players).filter(p => p.isFolded.some(f => f === false));
    const allHaveActed = allActivePlayers.every(p => p.hasActed);
    
    let allBetsAreEqual = true;
    for(let i=0; i < settings.numBoards; i++) {
        const boardActivePlayers = Object.values(players).filter(p => !p.isFolded[i]);
        if(!boardActivePlayers.every(p => p.currentBets[i] === gameState.currentBets[i])) {
            allBetsAreEqual = false;
            break;
        }
    }

    if (allHaveActed && allBetsAreEqual) {
        dealCommunityCardsForStage(channelId);
        return;
    }

    let currentIndex = Object.keys(players).indexOf(gameState.turnId);
    let nextPlayerId;
    do {
        currentIndex = (currentIndex + 1) % Object.keys(players).length;
        nextPlayerId = Object.keys(players)[currentIndex];
    } while (players[nextPlayerId].isFolded.every(f => f === true)); // Skip players folded on all boards
    
    gameState.turnId = nextPlayerId;
    players[nextPlayerId].hasActed = false;
}

function dealCommunityCardsForStage(channelId) {
    const channel = channels[channelId];
    if (!channel) return;
    const { gameState, settings } = channel;
    const stageIndex = gameState.currentStage;

    if (stageIndex >= settings.cardsPerStage.length) {
        determineWinner(channelId);
        return;
    }

    const cardsToDeal = settings.cardsPerStage[stageIndex];
    for (let i = 0; i < settings.numBoards; i++) {
        for (let j = 0; j < cardsToDeal; j++) {
            if (gameState.deck.length > 0) {
                gameState.communityCards[i].push(gameState.deck.pop());
            }
        }
    }
    
    gameState.currentStage++;
    startBettingRound(channelId, false);
}


function determineWinner(channelId) {
    const channel = channels[channelId];
    if (!channel) return;
    const { gameState, players, settings } = channel;

    for (let i = 0; i < settings.numBoards; i++) {
        let winners = [];
        let bestHandRank = null;
        const playersInHand = Object.values(players).filter(p => !p.isFolded[i]);

        playersInHand.forEach(player => {
            const handRank = evaluateHand(player.hand, gameState.communityCards[i]);
            if (!bestHandRank || compareHands(handRank, bestHandRank) > 0) {
                bestHandRank = handRank;
                winners = [{playerId: player.id, handName: handRank.name}];
            } else if (compareHands(handRank, bestHandRank) === 0) {
                winners.push({playerId: player.id, handName: handRank.name});
            }
        });
        gameState.winners[i] = winners;
        distributePot(channelId, i, winners);
    }
    
    gameState.turnId = null;
}

function distributePot(channelId, boardIndex, winners) {
    const channel = channels[channelId];
    if (!channel) return;
    const { gameState, players } = channel;

    const pot = gameState.pot[boardIndex];
    if (pot <= 0 || !winners || winners.length === 0) return;

    const winAmount = Math.floor(pot / winners.length);
    winners.forEach(winner => {
        if (players[winner.playerId]) {
            players[winner.playerId].chips += winAmount;
        }
    });
}


// Dummy evaluation functions
function evaluateHand(hand, community = []) {
    const allCards = [...hand, ...community];
    const rank = Math.floor(Math.random() * 9);
    const HAND_NAMES = { 0: "High Card", 1: "Pair", 2: "Two Pair", 3: "Three of a Kind", 4: "Straight", 5: "Flush", 6: "Full House", 7: "Four of a Kind", 8: "Straight Flush", 9: "Five of a Kind" };
    return { rank: rank, name: HAND_NAMES[rank], values: [rank] };
}
function compareHands(h1, h2) { return h1.rank - h2.rank; }

server.listen(PORT, () => console.log(`Poker server running on port ${PORT}`));
