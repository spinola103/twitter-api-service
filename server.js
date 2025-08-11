import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import NodeCache from "node-cache";
import { TwitterApi } from "twitter-api-v2";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Cache for 5 minutes to avoid duplicate API calls
const cache = new NodeCache({ stdTTL: 300 });

// Initialize Twitter API client
const twitterClient = new TwitterApi({
  appKey: process.env.TWITTER_API_KEY,
  appSecret: process.env.TWITTER_API_SECRET,
  accessToken: process.env.TWITTER_ACCESS_TOKEN,
  accessSecret: process.env.TWITTER_ACCESS_SECRET,
});

const rwClient = twitterClient.readWrite;

// Enhanced rate limiting tracker
const rateLimiter = {
  requests: [],
  windowMs: 15 * 60 * 1000, // 15 minutes
  maxRequests: 250, // Conservative limit (Twitter allows 300)
  
  canMakeRequest() {
    const now = Date.now();
    const windowStart = now - this.windowMs;
    
    // Remove old requests
    this.requests = this.requests.filter(time => time > windowStart);
    
    return this.requests.length < this.maxRequests;
  },
  
  recordRequest() {
    this.requests.push(Date.now());
  },
  
  getStatus() {
    const now = Date.now();
    const windowStart = now - this.windowMs;
    const validRequests = this.requests.filter(time => time > windowStart);
    
    return {
      requestsInWindow: validRequests.length,
      maxRequests: this.maxRequests,
      remainingRequests: this.maxRequests - validRequests.length,
      resetTime: new Date(now + this.windowMs).toISOString()
    };
  }
};

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Health check with detailed status
app.get('/', (req, res) => {
  const rateStatus = rateLimiter.getStatus();
  res.json({ 
    status: 'Twitter API Service is running',
    rateLimit: rateStatus,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    endpoints: {
      scrape: 'POST /scrape - Single account',
      bulk: 'POST /scrape/bulk - Multiple accounts',
      rateLimit: 'GET /rate-limit - Rate limit status',
      clearCache: 'POST /cache/clear - Clear cache'
    }
  });
});

// Extract username from Twitter URL
function extractUsername(url) {
  try {
    const match = url.match(/(?:twitter\.com|x\.com)\/([^\/\?]+)/);
    return match ? match[1].toLowerCase() : null;
  } catch {
    return null;
  }
}

// Get user tweets via API with comprehensive data
async function getUserTweets(username, maxResults = 5) {
  try {
    // Check cache first
    const cacheKey = `tweets_${username}_${maxResults}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      return { ...cached, fromCache: true };
    }

    // Check rate limit
    if (!rateLimiter.canMakeRequest()) {
      throw new Error('Rate limit exceeded. Please try again in 15 minutes.');
    }

    // Get user ID first
    rateLimiter.recordRequest();
    const user = await rwClient.v2.userByUsername(username, {
      'user.fields': ['created_at', 'description', 'public_metrics', 'verified', 'profile_image_url']
    });

    if (!user.data) {
      throw new Error(`User @${username} not found`);
    }

    // Check rate limit again before timeline request
    if (!rateLimiter.canMakeRequest()) {
      throw new Error('Rate limit exceeded after user lookup');
    }

    // Get user timeline with comprehensive fields
    rateLimiter.recordRequest();
    const timeline = await rwClient.v2.userTimeline(user.data.id, {
      max_results: Math.min(maxResults, 100), // Ensure we don't exceed API limits
      exclude: ['retweets', 'replies'], // Only original tweets
      'tweet.fields': [
        'created_at',
        'public_metrics',
        'context_annotations',
        'entities',
        'attachments'
      ],
      'media.fields': ['type', 'url', 'preview_image_url'],
      expansions: ['attachments.media_keys']
    });

    // Debug logging
    console.log(`Timeline response for @${username}:`, {
      hasData: !!timeline.data,
      dataType: typeof timeline.data,
      isArray: Array.isArray(timeline.data),
      dataLength: timeline.data ? timeline.data.length : 0
    });

    const tweets = Array.isArray(timeline.data) ? timeline.data : [];
    const mediaMap = timeline.includes?.media ? 
      Object.fromEntries(timeline.includes.media.map(media => [media.media_key, media])) : {};

    // Check if we have any tweets
    if (tweets.length === 0) {
      console.log(`No tweets found for @${username}`);
    }

    // Process tweets with enhanced data
    const processedTweets = tweets.map((tweet, index) => {
      const media = tweet.attachments?.media_keys?.map(key => mediaMap[key]) || [];
      
      return {
        index: index + 1,
        id: tweet.id,
        text: tweet.text,
        link: `https://twitter.com/${username}/status/${tweet.id}`,
        timestamp: tweet.created_at,
        replies: tweet.public_metrics?.reply_count || 0,
        retweets: tweet.public_metrics?.retweet_count || 0,
        likes: tweet.public_metrics?.like_count || 0,
        quotes: tweet.public_metrics?.quote_count || 0,
        hasMedia: media.length > 0,
        mediaCount: media.length,
        mediaTypes: media.map(m => m.type),
        extractedAt: new Date().toISOString()
      };
    });

    // Check for recent tweets (last 24 hours)
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recentTweetsCount = processedTweets.filter(tweet => 
      new Date(tweet.timestamp) >= twentyFourHoursAgo
    ).length;

    const result = {
      success: true,
      username: username,
      userInfo: {
        id: user.data.id,
        name: user.data.name,
        username: user.data.username,
        description: user.data.description,
        verified: user.data.verified || false,
        profileImage: user.data.profile_image_url,
        followers: user.data.public_metrics?.followers_count || 0,
        following: user.data.public_metrics?.following_count || 0,
        tweetCount: user.data.public_metrics?.tweet_count || 0,
        createdAt: user.data.created_at
      },
      tweetsCount: processedTweets.length,
      tweets: processedTweets,
      metadata: {
        recentTweetsFound: recentTweetsCount,
        scrapedAt: new Date().toISOString(),
        method: 'twitter_api_v2'
      }
    };

    // Cache the result
    cache.set(cacheKey, result, 300); // Cache for 5 minutes

    return result;

  } catch (error) {
    console.error(`Error fetching tweets for @${username}:`, error);
    
    // Handle specific Twitter API errors
    if (error.data?.errors) {
      const apiError = error.data.errors[0];
      if (apiError.code === 50) {
        throw new Error(`User @${username} not found`);
      } else if (apiError.code === 63) {
        throw new Error(`User @${username} has been suspended`);
      } else if (apiError.code === 179) {
        throw new Error(`User @${username} is private`);
      }
    }
    
    if (error.code === 429 || error.status === 429) {
      throw new Error('Twitter API rate limit exceeded');
    } else if (error.code === 401 || error.status === 401) {
      throw new Error('Twitter API authentication failed');
    } else if (error.code === 404 || error.status === 404) {
      throw new Error(`User @${username} not found or is private`);
    } else if (error.code === 403 || error.status === 403) {
      throw new Error(`Access forbidden for user @${username}`);
    } else {
      throw new Error(`API Error: ${error.message || 'Unknown error occurred'}`);
    }
  }
}

// Single account endpoint
app.post('/scrape', async (req, res) => {
  const { url } = req.body;
  
  if (!url) {
    return res.status(400).json({ 
      error: 'URL is required',
      example: { url: 'https://twitter.com/username' }
    });
  }

  const username = extractUsername(url);
  if (!username) {
    return res.status(400).json({
      error: 'Invalid Twitter URL format'
    });
  }

  try {
    const result = await getUserTweets(username, 5);
    res.json(result);
  } catch (error) {
    res.status(500).json({
      error: 'Failed to fetch tweets',
      message: error.message,
      url: url
    });
  }
});

// Bulk endpoint optimized for n8n (handles up to 15 accounts)
app.post('/scrape/bulk', async (req, res) => {
  const { urls, maxTweets = 5 } = req.body;
  
  if (!urls || !Array.isArray(urls)) {
    return res.status(400).json({ 
      error: 'URLs array is required',
      example: { 
        urls: ['https://twitter.com/username1', 'https://twitter.com/username2'],
        maxTweets: 5
      }
    });
  }

  if (urls.length > 15) {
    return res.status(400).json({
      error: 'Maximum 15 URLs allowed per bulk request'
    });
  }

  // Extract usernames and filter valid ones
  const usernames = urls.map(extractUsername).filter(Boolean);
  if (usernames.length === 0) {
    return res.status(400).json({
      error: 'No valid Twitter URLs found'
    });
  }

  // Check if we have enough rate limit capacity
  const rateStatus = rateLimiter.getStatus();
  const estimatedRequests = usernames.length * 2; // 2 requests per user (lookup + timeline)
  
  if (rateStatus.remainingRequests < estimatedRequests) {
    return res.status(429).json({
      error: 'Insufficient rate limit capacity',
      required: estimatedRequests,
      remaining: rateStatus.remainingRequests,
      resetTime: rateStatus.resetTime
    });
  }

  const results = [];
  const errors = [];

  // Process accounts with progressive delay to avoid hitting rate limits
  for (let i = 0; i < usernames.length; i++) {
    const username = usernames[i];
    
    try {
      // Add progressive delay to spread requests (starts at 2s, increases by 1s each iteration)
      if (i > 0) {
        await new Promise(resolve => setTimeout(resolve, 2000 + (i * 1000)));
      }
      
      const result = await getUserTweets(username, maxTweets);
      results.push(result);
      
    } catch (error) {
      console.error(`Failed to fetch tweets for @${username}:`, error.message);
      errors.push({
        username,
        error: error.message
      });
      
      // If rate limit hit, stop processing remaining accounts
      if (error.message.includes('rate limit')) {
        break;
      }
    }
  }

  const response = {
    success: true,
    processed: results.length,
    total: usernames.length,
    results: results,
    rateLimit: rateLimiter.getStatus(),
    processedAt: new Date().toISOString()
  };

  if (errors.length > 0) {
    response.errors = errors;
  }

  res.json(response);
});

// Rate limit status endpoint
app.get('/rate-limit', (req, res) => {
  res.json(rateLimiter.getStatus());
});

// Clear cache endpoint
app.post('/cache/clear', (req, res) => {
  cache.flushAll();
  res.json({ 
    success: true, 
    message: 'Cache cleared',
    timestamp: new Date().toISOString()
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  
  if (res.headersSent) {
    return next(err);
  }
  
  res.status(500).json({
    error: 'Internal server error',
    message: err.message
  });
});

// Graceful error handling
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  process.exit(1);
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Twitter API Service running on port ${PORT}`);
  console.log(`📝 Endpoints:`);
  console.log(`   GET  / - Health check and service info`);
  console.log(`   POST /scrape - Single account scraping`);
  console.log(`   POST /scrape/bulk - Multiple accounts scraping`);
  console.log(`   GET  /rate-limit - Rate limit status`);
  console.log(`   POST /cache/clear - Clear cache`);
  
  // Validate API credentials on startup
  if (!process.env.TWITTER_API_KEY || !process.env.TWITTER_API_SECRET) {
    console.error('❌ Missing Twitter API credentials!');
    console.log('Required environment variables:');
    console.log('- TWITTER_API_KEY');
    console.log('- TWITTER_API_SECRET');
    console.log('- TWITTER_ACCESS_TOKEN');
    console.log('- TWITTER_ACCESS_SECRET');
  } else {
    console.log('✅ Twitter API credentials loaded');
  }
});