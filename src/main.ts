import EventEmitter from "events";
import readLine from "readline";
import SteamUser from "steam-user";
import axios from "axios";
import { CookieJar } from "tough-cookie";
import { wrapper } from "axios-cookiejar-support";
import { load } from "cheerio";
import fs from "fs";
import dotenv from "dotenv";

const logger = {
	debug(...debug: (Record<any, any> | string | number)[]) {
		console.log("[!]", ...debug);
	},

	error(...error: (string | Error)[]) {
		console.log("[!!!]", ...error);
	},

	log(...log: string[]) {
		console.log(...log);
	},
};

type GameTradingCards = {
	appTitle: string;
	appId: number;
	leftCards: number;
};

class CardFarmer extends EventEmitter {
	static MAX_GAMES_TO_IDLE = 27;
	static TIMEOUT_BETWEEN_CHECKS = 15 * 6e4;

	static SELECTED_GAMES_FILE_NAME = "2idle.json";

	private _accountName;
	private _password;
	private _parentalPin;

	private _steamClient;
	private _axiosClient;
	private _cookiesJar;

	private _sessionId = "";

	private _readline;

	private _userGames?: Set<number>;

	private _delayTimeout?: NodeJS.Timeout;
	private _privacyTimeout?: NodeJS.Timeout;

	constructor(
		accountName?: string,
		password?: string,
		parentalPin?: string | number,
	) {
		super();

		this._accountName = accountName;
		this._password = password;
		this._parentalPin = parentalPin ? +parentalPin : 0;

		this._readline = readLine.createInterface({
			input: process.stdin,
			output: process.stdout,
		});

		this._cookiesJar = new CookieJar();
		this._axiosClient = wrapper(
			axios.create({
				baseURL: "https://steamcommunity.com/",
				headers: {
					"User-Agent":
						"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36 OPR/101.0.0.0",
					Origin: "https://steamcommunity.com",
					Referer: "https://steamcommunity.com/",
				},
				jar: this._cookiesJar,
			}),
		);

		// load user's picked games if possible
		if (fs.existsSync(CardFarmer.SELECTED_GAMES_FILE_NAME)) {
			try {
				this._userGames = new Set<number>(
					JSON.parse(
						fs.readFileSync(
							CardFarmer.SELECTED_GAMES_FILE_NAME,
							"utf8",
						),
					).map(Number),
				);
			} catch (exception) {
				logger.error("2idle.json has a wrong format!");
			}
		}

		this._steamClient = new SteamUser();

		// STEAM-USER LISTENERS
		this._steamClient.once("loggedOn", () => {
			this._steamClient.setPersona(SteamUser.EPersonaState.Offline);

			this._steamClient.webLogOn();

			this.emit("LOGIN");
		});

		this._steamClient.once("webSession", (_, cookies) => {
			cookies.forEach((cookie) => {
				this.setAxiosCookie(cookie);

				if (cookie.indexOf("sessionid") !== -1) {
					this._sessionId = cookie.replace(/.*=(.*?)/, "$1");
				}
			});

			logger.log("Session ID successfully received.");

			this.emit("WEB_LOGIN");
		});

		this._steamClient.once("steamGuard", (mailDomain, callback) => {
			if (!mailDomain) {
				logger.log("Steam guard code required. Enter it below.");
			} else {
				logger.log("Security code sent to your email: ", mailDomain);
			}

			this._readline.question("Code: ", (steamGuard: string) => {
				callback(steamGuard);
			});
		});

		this._steamClient.on("newItems", (itemCount) => {
			logger.debug("New items:", itemCount);
		});

		// OTHER LISTENERS
		this._readline.on("line", this._handleOnLine);

		this.on("WEB_LOGIN", this._fetchCardsAndPlay);
		this.on("FETCH_CARDS", this._fetchCardsAndPlay);
		this.on("QUIT_PLAYING", this._quitIdleGames);
	}

	start(accountName?: string, password?: string, twoFactorCode?: string) {
		this._steamClient.logOn({
			accountName: this._accountName || accountName,
			password: this._password || password,
			twoFactorCode,
		});
	}

	setAxiosCookie(cookie: string) {
		this._cookiesJar.setCookie(cookie, "https://steamcommunity.com");
		//this._cookiesJar.setCookie(cookie, "https://store.steampowered.com");
	}

	async parentalUnlock(pin: number | string) {
		const payload = new FormData();
		payload.append("pin", pin.toString());
		payload.append("sessionid", this._sessionId);

		const response = await this._axiosClient.post(
			"/parental/ajaxunlock",
			payload,
		);

		if (response.data.success && response.headers["set-cookie"]) {
			const parentalCookie = response.headers["set-cookie"].find(
				(cookie) => cookie.indexOf("steamparental") !== -1,
			);

			if (parentalCookie) {
				logger.debug("Successfully bypassed parental-wall!");

				return parentalCookie;
			}
		}

		this._steamClient.logOff();

		throw new Error("wrong pin!");
	}

	// hid "<username> played <game> for the first time" from the activity tab
	async setTempProfilePrivacy(isPrivate: boolean) {
		const payload = new FormData();
		payload.append("sessionid", this._sessionId);
		payload.append(
			"Privacy",
			`{"PrivacyProfile":${
				isPrivate ? 1 : 3
			},"PrivacyInventory":2,"PrivacyInventoryGifts":1,"PrivacyOwnedGames":3,"PrivacyPlaytime":3,"PrivacyFriendsList":2}`,
		);
		payload.append("eCommentPermission", "0");

		const response = await this._axiosClient.post(
			`/profiles/${this._steamClient.steamID?.toString()}/ajaxsetprivacy/`,
			payload,
		);

		if (!response.data.success) {
			this._steamClient.logOff();

			throw new Error(
				"unexpected error when setting profile to private!",
			);
		}

		logger.debug("Profile is now", isPrivate ? "private" : "public");

		if (isPrivate) {
			this._privacyTimeout = setTimeout(() => {
				this.setTempProfilePrivacy(false);
			}, 10e3);
		}
	}

	async getBadges(): Promise<GameTradingCards[]> {
		let totalPages = 1;
		const gamesWithCards = [] as GameTradingCards[];

		for (let currentPage = 1; currentPage <= totalPages; currentPage++) {
			try {
				const badgesResponse = await this._axiosClient.get(
					`/profiles/${this._steamClient.steamID?.toString()}/badges?p=${currentPage}`,
				);
				const $ = load(badgesResponse.data);

				logger.debug("Reading badges page:", currentPage);

				totalPages =
					$(".profile_paging").first().find(".pagelink").length + 1;

				$(".badges_sheet .badge_row").each((_, element) => {
					const $element = $(element);
					const remainingCards = $element
						.find(
							".badge_row_inner .badge_title_row .badge_title_stats_drops .progress_info_bold",
						)
						.text()
						.replace(/[^0-9]+/g, "");

					if (remainingCards) {
						const appId = +$element
							.find(".badge_row_overlay")
							.attr("href")!
							.replace(/.*cards\/(.*)\//, "$1");

						if (
							!this._userGames ||
							(this._userGames && this._userGames.has(appId))
						) {
							const appTitle = $element
								.find(
									".badge_row_inner .badge_title_row .badge_title",
								)
								.contents()
								.first()
								.text()
								.trim();

							gamesWithCards.push({
								appId,
								appTitle,
								leftCards: +remainingCards,
							});
						}
					}
				});
			} catch (response) {
				logger.debug("Parental wall");

				if (!this._parentalPin) {
					throw new Error("parental pin not passed!");
				}

				await this.parentalUnlock(this._parentalPin);

				return await this.getBadges();
			}
		}

		return gamesWithCards;
	}

	private async _idleGames(games?: GameTradingCards[]) {
		if (games) {
			await this.setTempProfilePrivacy(true);

			logger.debug("Now idling:");
			games.forEach((game) => {
				logger.debug(
					game.appTitle,
					`(${game.appId})`,
					"-",
					game.leftCards,
					"trading card(s) left.",
				);
			});

			this._steamClient.gamesPlayed(games.map((game) => game.appId));
		} else {
			logger.debug("All games were idled.");
		}
	}

	private _quitIdleGames() {
		this._steamClient.gamesPlayed([]);
	}

	private _fetchCardsAndPlay = async () => {
		const gamesWithCards = await this.getBadges();

		if (!gamesWithCards.length) {
			this._idleGames();

			this.close();

			return;
		}

		this._idleGames(gamesWithCards.slice(0, CardFarmer.MAX_GAMES_TO_IDLE));

		logger.debug(
			"Next fetch in",
			CardFarmer.TIMEOUT_BETWEEN_CHECKS / 6e4,
			"minute(s).",
		);

		clearTimeout(this._delayTimeout);
		this._delayTimeout = setTimeout(() => {
			logger.debug(
				"Quit from playing games and delay 10s till next 15mins play lapse...",
			);

			this._quitIdleGames();

			this._delayTimeout = setTimeout(this._fetchCardsAndPlay, 10e3);
		}, CardFarmer.TIMEOUT_BETWEEN_CHECKS);
	};

	async close() {
		logger.debug("Exiting...");

		clearTimeout(this._delayTimeout);
		clearTimeout(this._privacyTimeout);

		this._readline.close();

		this._steamClient.logOff();
	}

	private _handleOnLine = (line: string) => {
		const [cmd, ...args] = line.split(/\s/);

		switch (cmd) {
			case "exit":
				this.close();
				break;

			case "state":
				if (args[0]) {
					const state =
						args[0].charAt(0) + args[0].slice(1).toLowerCase();

					const personaStates = Object.entries(
						SteamUser.EPersonaState,
					);
					const personaState = personaStates.find(
						([stateName]) => stateName === state,
					);

					if (personaState) {
						this._steamClient.setPersona(+personaState[1]);
					}
				}
		}
	};
}

let user, pass, pin;

if (process.argv.length - 2 >= 2) {
	const correctProcess = process.argv.slice(2);

	user = correctProcess[0];
	pass = correctProcess[1];
	pin = correctProcess[2];
} else {
	dotenv.config();

	if (process.env.user && process.env.pass) {
		user = process.env.user;
		pass = process.env.pass;
		pin = process.env.pin;
	}
}

if (user && pass) {
	const steam = new CardFarmer(user, pass, pin);

	logger.debug("Initializing card farmer... Write 'exit' to exit.");

	steam.start();
}
