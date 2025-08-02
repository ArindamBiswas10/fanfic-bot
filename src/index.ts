import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
} from "discord.js";
import axios from "axios";
import * as cheerio from "cheerio";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

puppeteer.use(StealthPlugin());

const TOKEN = process.env.DISCORD_TOKEN!;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ---------- AO3 SCRAPER ----------
async function scrapeAO3(pairing: string, maxPages = 5) {
  const collected: { title: string; link: string; summary: string }[] = [];
  const search = pairing.replace(/ /g, "+");

  for (let page = 1; page <= maxPages; page++) {
    const url = `https://archiveofourown.org/works/search?work_search%5Bquery%5D=${search}&page=${page}`;
    const res = await axios.get(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      },
    });
    const $ = cheerio.load(res.data);

    const results = $("li.work.blurb.group");
    if (results.length === 0) break;

    results.each((_, el) => {
      const titleTag = $(el).find("h4.heading a");
      const title = titleTag.text().trim();
      const link = "https://archiveofourown.org" + titleTag.attr("href");
      const summary =
        $(el).find("blockquote.userstuff.summary").text().trim() ||
        "No summary provided.";
      collected.push({ title, link, summary });
    });
  }

  return collected;
}

// ---------- FANFICTION.NET SCRAPER (puppeteer) ----------
async function scrapeFFNet(pairing: string, maxPages = 1) {
  const collected: { title: string; link: string; summary: string }[] = [];
  const search = pairing.replace(/ /g, "+");

  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();

  for (let p = 1; p <= maxPages; p++) {
    const url = `https://www.fanfiction.net/search/?keywords=${search}&type=story&p=${p}`;
    await page.goto(url, { waitUntil: "networkidle2" });

    // Replace waitForTimeout with manual sleep
    await new Promise(resolve => setTimeout(resolve, 2000));

    const html = await page.content();
    const $ = cheerio.load(html);

    $("div.z-list").each((_, el) => {
      const titleEl = $(el).find("a.stitle");
      const title = titleEl.text().trim();
      const href = titleEl.attr("href");
      const link = href?.startsWith("http")
        ? href
        : "https://www.fanfiction.net" + href;
      const summary =
        $(el).find("div.z-indent").text().trim() || "No summary provided.";
      if (title && link) collected.push({ title, link, summary });
    });
  }

  await browser.close();
  return collected;
}


// ---------- PAGINATION ----------
function paginateResults(
  results: { title: string; link: string; summary: string }[],
  pairing: string
) {
  const pageSize = 5;
  const pages: typeof results[] = [];
  for (let i = 0; i < results.length; i += pageSize) {
    pages.push(results.slice(i, i + pageSize));
  }

  const makeEmbed = (pageIndex: number) => {
    const page = pages[pageIndex];
    const embed = new EmbedBuilder()
      .setTitle(`Fanfics for ${pairing}`)
      .setColor(0xff66cc)
      .setFooter({ text: `Page ${pageIndex + 1} of ${pages.length}` });

    page.forEach((fic) => {
      const shortSummary =
        fic.summary.length > 200
          ? fic.summary.substring(0, 200) + "..."
          : fic.summary;
      embed.addFields({
        name: fic.title,
        value: `${fic.link}\n${shortSummary}`,
      });
    });

    return embed;
  };

  return { pages, makeEmbed };
}

// ---------- COMMAND HANDLER ----------
client.on("messageCreate", async (message) => {
  if (!message.content.startsWith("!fanfic") || message.author.bot) return;

  const pairing = message.content.replace("!fanfic", "").trim() || "naruto sakura";

  const sourceRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("ao3")
      .setLabel("AO3")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("ffn")
      .setLabel("FanFiction.net")
      .setStyle(ButtonStyle.Secondary)
  );

  const promptMsg = await message.channel.send({
    content: `Choose a source for **${pairing}** fanfics:`,
    components: [sourceRow],
  });

  const sourceCollector = promptMsg.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: 1000 * 60,
  });

  sourceCollector.on("collect", async (interaction) => {
    if (interaction.user.id !== message.author.id) {
      return interaction.reply({
        content: "Only the requester can use these buttons.",
        ephemeral: true,
      });
    }

    await interaction.deferUpdate();
    let results: { title: string; link: string; summary: string }[] = [];

    if (interaction.customId === "ao3") {
      await interaction.editReply({
        content: `Searching AO3 for **${pairing}**...`,
        components: [],
      });
      results = await scrapeAO3(pairing, 10);
    } else {
      await interaction.editReply({
        content: `Searching FanFiction.net for **${pairing}**...`,
        components: [],
      });
      results = await scrapeFFNet(pairing, 1);
    }

    if (results.length === 0) {
      return interaction.followUp(
        `No fanfics found on ${interaction.customId.toUpperCase()}.`
      );
    }

    const { pages, makeEmbed } = paginateResults(results, pairing);
    let currentPage = 0;

    const navRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("prev")
        .setEmoji("◀")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId("next")
        .setEmoji("▶")
        .setStyle(ButtonStyle.Primary)
    );

    const fanficMsg = await message.channel.send({
      embeds: [makeEmbed(currentPage)],
      components: [navRow],
    });

    const navCollector = fanficMsg.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: 1000 * 60 * 2,
    });

    navCollector.on("collect", (navInteraction) => {
      if (navInteraction.user.id !== message.author.id) {
        navInteraction.reply({
          content: "Only the requester can use these buttons.",
          ephemeral: true,
        });
        return;
      }

      if (navInteraction.customId === "prev") {
        currentPage = currentPage > 0 ? currentPage - 1 : pages.length - 1;
      } else {
        currentPage = (currentPage + 1) % pages.length;
      }

      navInteraction.update({
        embeds: [makeEmbed(currentPage)],
        components: [navRow],
      });
    });

    navCollector.on("end", () => {
      const disabledNavRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        navRow.components.map((btn) =>
          ButtonBuilder.from(btn as ButtonBuilder).setDisabled(true)
        )
      );
      fanficMsg.edit({ components: [disabledNavRow] });
    });
  });
});

client.once("ready", () => {
  console.log(`Logged in as ${client.user?.tag}`);
});

client.login(TOKEN);
