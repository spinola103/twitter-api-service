import express from "express";
import dotenv from "dotenv";
import { TwitterApi } from "twitter-api-v2";
import NodeCache from "node-cache";

dotenv.config();
const app = express();
const port = process.env.PORT || 8080;

const cache = new NodeCache({ stdTTL: 300 });
const rwClient = new TwitterApi(process.env.TWITTER_BEARER_TOKEN);

const rateLimiter = {
  resetTime: null, // Unix timestamp of next reset
  remaining: null, // Remaining calls
};

// Sleep utility
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Wait until rate limit resets
async function waitForRateLimitReset() {
  const now = Date.now();
  if (rateLimiter.resetTime && now < rateLimiter.resetTime) {
    const waitMs = rateLimiter.resetTime - now;
    console.log(`⏳ Waiting ${Math.ceil(waitMs / 1000)}s for rate limit reset`);
    await sleep(waitMs);
  }
}

// Extract username from Twitter/X URL
function extractUsername(url) {
  try {
    const parsedUrl = new URL(url);
    if (
      parsedUrl.hostname.includes("twitter.com") ||
      parsedUrl.hostname.includes("x.com")
    ) {
      return parsedUrl.pathname.split("/")[1];
    }
    return null;
  } catch {
    return null;
  }
}

// Get tweets for one user
async function getUserTweets(username) {
  const cacheKey = `tweets_${username}`;
  if (cache.has(cacheKey)) {
    return cache.get(cacheKey);
  }

  await waitForRateLimitReset();

  try {
    // Get user ID
    const userRes = await rwClient.v2.userByUsername(username, {
      "user.fields": ["id", "name", "username"],
    });

    if (!userRes || !userRes.data) {
      throw new Error("User not found");
    }

    // Update rate limit info from user call
    if (userRes.rateLimit) {
      rateLimiter.remaining = userRes.rateLimit.remaining;
      rateLimiter.resetTime = userRes.rateLimit.reset * 1000;
    }

    // If rate limit reached, wait
    if (rateLimiter.remaining === 0) {
      await waitForRateLimitReset();
    }

    // Get latest tweets
    const tweetRes = await rwClient.v2.userTimeline(userRes.data.id, {
      max_results: 5,
      "tweet.fields": ["created_at", "text", "id"],
      exclude: ["replies", "retweets"],
    });

    // Update rate limit info from timeline call
    if (tweetRes.rateLimit) {
      rateLimiter.remaining = tweetRes.rateLimit.remaining;
      rateLimiter.resetTime = tweetRes.rateLimit.reset * 1000;
    }

    if (!tweetRes.data || !tweetRes.data.data) {
      return [];
    }

    const tweets = tweetRes.data.data.map((t) => ({
      id: t.id,
      text: t.text,
      created_at: t.created_at,
      url: `https://twitter.com/${username}/status/${t.id}`,
    }));

    cache.set(cacheKey, tweets);
    return tweets;
  } catch (error) {
    if (error.data?.title === "Rate limit exceeded") {
      console.error("🚨 Rate limit hit, waiting...");
      await waitForRateLimitReset();
      return getUserTweets(username); // retry
    }
    throw error;
  }
}

// Endpoint for single username
app.get("/tweets", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: "Missing url parameter" });

  const username = extractUsername(url);
  if (!username)
    return res.status(400).json({ error: "Invalid Twitter URL" });

  try {
    const tweets = await getUserTweets(username);
    res.json({ username, tweets });
  } catch (err) {
    res.status(500).json({
      error: "Failed to fetch tweets",
      message: err.message,
      url,
    });
  }
});

// Bulk endpoint
app.get("/tweets/bulk", async (req, res) => {
  const urls = req.query.urls ? req.query.urls.split(",") : [];
  if (urls.length === 0)
    return res.status(400).json({ error: "Missing urls parameter" });

  try {
    const results = {};
    for (const url of urls) {
      const username = extractUsername(url);
      if (!username) {
        results[url] = { error: "Invalid Twitter URL" };
        continue;
      }
      try {
        results[url] = await getUserTweets(username);
      } catch (err) {
        results[url] = { error: err.message };
      }
    }
    res.json(results);
  } catch (err) {
    res.status(500).json({
      error: "Failed to fetch bulk tweets",
      message: err.message,
    });
  }
});

app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});
