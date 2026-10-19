/// <reference types="@rbxts/testez/globals" />

import { createHarness, kinds, lastEvent, reasonOf, startTrade } from "./support";

export = () => {
	describe("sending requests", () => {
		it("refuses requests to yourself and duplicates", () => {
			const { service } = createHarness({ requestCooldown: 0 });

			expect(reasonOf(service.request("alice", "alice"))).to.equal("SelfTrade");

			service.request("alice", "bob");
			expect(reasonOf(service.request("alice", "bob"))).to.equal("AlreadyRequested");
		});

		it("makes a player wait between requests", () => {
			const harness = createHarness({ requestCooldown: 3 });
			const { service } = harness;

			service.request("alice", "bob");
			expect(reasonOf(service.request("alice", "carol"))).to.equal("Cooldown");

			harness.advance(3);
			expect(service.request("alice", "carol").ok).to.equal(true);
		});

		it("caps how many requests a player can have out", () => {
			const { service } = createHarness({ requestCooldown: 0, maxOutgoingRequests: 2 });

			service.request("alice", "bob");
			service.request("alice", "carol");
			expect(reasonOf(service.request("alice", "dave"))).to.equal("TooManyRequests");
		});

		it("caps how many requests can pile up on one player", () => {
			const { service } = createHarness({ maxIncomingRequests: 2 });

			service.request("alice", "zoe");
			service.request("bob", "zoe");
			expect(reasonOf(service.request("carol", "zoe"))).to.equal("TargetBusy");

			service.decline("zoe", "alice");
			expect(service.request("carol", "zoe").ok).to.equal(true);
		});

		it("refuses a request between players who are already trading", () => {
			const harness = createHarness({ requestCooldown: 0 });
			startTrade(harness);

			expect(reasonOf(harness.service.request("alice", "bob"))).to.equal("AlreadyTrading");
		});
	});

	describe("answering requests", () => {
		it("starts a trade when the other player accepts", () => {
			const harness = createHarness();
			const { service, events } = harness;

			expect(service.request("alice", "bob").ok).to.equal(true);
			expect(service.getIncomingRequests("bob").size()).to.equal(1);
			expect(service.accept("bob", "alice").ok).to.equal(true);

			expect(kinds(events)).to.equal("requested,requestClosed,started");
			expect(lastEvent(events, "requestClosed")!.reason).to.equal("Accepted");

			const trade = service.getTrade("bob")!;
			expect(trade.players[0]).to.equal("alice");
			expect(trade.players[1]).to.equal("bob");
			expect(service.getTrade("alice")!.id).to.equal(trade.id);
			expect(service.getIncomingRequests("bob").size()).to.equal(0);
		});

		it("declines and cancels requests", () => {
			const { service, events } = createHarness({ requestCooldown: 0 });

			service.request("alice", "bob");
			expect(service.decline("bob", "alice").ok).to.equal(true);
			expect(lastEvent(events, "requestClosed")!.reason).to.equal("Declined");
			expect(reasonOf(service.accept("bob", "alice"))).to.equal("NoRequest");

			service.request("alice", "carol");
			expect(service.cancelRequest("alice", "carol").ok).to.equal(true);
			expect(lastEvent(events, "requestClosed")!.reason).to.equal("Cancelled");
			expect(service.cancelRequest("alice", "carol").ok).to.equal(false);
		});

		it("ends the current trade when a player accepts another", () => {
			const harness = createHarness({ requestCooldown: 0 });
			const { service, events } = harness;
			harness.inventory.give("alice", ["sword"]);
			startTrade(harness);
			service.addItem("alice", "sword");

			service.request("carol", "bob");
			service.accept("bob", "carol");

			const ended = lastEvent(events, "ended")!;
			expect(ended.reason).to.equal("StartedAnother");
			expect(ended.trade.players[0]).to.equal("alice");
			expect(service.isTrading("alice")).to.equal(false);
			expect(service.isLocked("sword")).to.equal(false);
			expect(service.getTrade("bob")!.players[0]).to.equal("carol");
		});

		it("clears the reverse request when two players ask each other", () => {
			const { service, events } = createHarness({ requestCooldown: 0 });

			service.request("alice", "bob");
			service.request("bob", "alice");
			service.accept("bob", "alice");

			expect(service.getIncomingRequests("alice").size()).to.equal(0);
			expect(lastEvent(events, "requestClosed")!.reason).to.equal("Cancelled");
		});
	});

	describe("request cleanup", () => {
		it("expires requests that aren't answered in time", () => {
			const harness = createHarness({ requestTimeout: 30 });
			const { service, events } = harness;

			service.request("alice", "bob");
			harness.advance(29);
			service.update();
			expect(service.getIncomingRequests("bob").size()).to.equal(1);

			harness.advance(1);
			service.update();
			expect(lastEvent(events, "requestClosed")!.reason).to.equal("Expired");
			expect(service.getIncomingRequests("bob").size()).to.equal(0);
		});

		it("won't accept an expired request even before update runs", () => {
			const harness = createHarness({ requestTimeout: 30 });

			harness.service.request("alice", "bob");
			harness.advance(31);

			expect(reasonOf(harness.service.accept("bob", "alice"))).to.equal("NoRequest");
			expect(harness.service.isTrading("bob")).to.equal(false);
		});

		it("closes every request to and from a player who leaves", () => {
			const { service, events } = createHarness({ requestCooldown: 0 });

			service.request("alice", "bob");
			service.request("bob", "carol");
			service.request("dave", "carol");
			service.playerLeft("bob");

			let left = 0;
			for (const event of events) {
				if (event.kind === "requestClosed" && event.reason === "PlayerLeft") {
					left += 1;
				}
			}
			expect(left).to.equal(2);
			expect(service.getIncomingRequests("carol").size()).to.equal(1);
		});
	});
};
