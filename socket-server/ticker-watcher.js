const { lookupTickers } = require('../app-actions/record-strat-perfs');

class TickerWatcher {
    constructor({ name, Robinhood, handler, timeout = 40000, onPick, disableOnPick }) {
        this.name = name;
        this.Robinhood = Robinhood;
        this.handler = handler;
        this.relatedPrices = {};
        this.running = false;
        this.timeout = timeout;
        this.tickersWatching = [];
        this.onPick = onPick;
        this.disableOnPick = disableOnPick;
    }
    // tickersRegistered = {}; // { AAPL: ['strategies'] }
    addTickers(tickers) {
        this.tickersWatching = [
            ...new Set(
                [...this.tickersWatching, ...tickers]
            )
        ];
    }
    removeTickers(tickers) {
        console.log('before', this.tickersWatching.length);
        this.tickersWatching = this.tickersWatching.filter(t => !tickers.includes(t));
        console.log('after', this.tickersWatching.length);
    }
    clearTickers() {
        this.tickersWatching = [];
    }
    async start() {
        this.running = true;
        await this.lookupAndWaitPrices();
    }
    stop() {
        this.running = false;
    }
    async lookupAndWaitPrices() {
        if (!this.running) return;
        await this.lookupRelatedPrices();
        setTimeout(() => this.lookupAndWaitPrices(), this.timeout);
    }
    async lookupRelatedPrices() {
        const { Robinhood, tickersWatching, handler, onPick, disableOnPick } = this;
        // console.log(this.picks);
        console.log(this.name, 'getRelatedPrices');
        console.log(this.name, 'getting related prices', tickersWatching.length);
        // console.log(JSON.stringify(tickersToLookup));
        const relatedPrices = await lookupTickers(
            Robinhood,
            tickersWatching,
            true
        );

        this.relatedPrices = relatedPrices;
        console.log(this.name, 'done getting related prices');

        const newPicks = await handler(relatedPrices);
        if (!disableOnPick && newPicks && newPicks.length) {
            for (let pick of newPicks) {
                await onPick(pick);
            }
        }

        return newPicks;

        // console.log(relatedPrices)
        // console.log(JSON.stringify(relatedPrices, null, 2));
    }
}

module.exports = TickerWatcher;