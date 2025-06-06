// dotenv
require('dotenv').config();
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const { Configuration, OpenAIApi } = require('openai');
const axios = require('axios');
const OpenAI = require('openai');
const { fileFromPath } = require("openai/uploads");
const FormData = require('form-data');

const OUTPUT_DIR = './output';

class ProductPhotoEnhancer {
  constructor() {
    this.inputDir = './input';
    this.outputDir = './output';
    this.ensureDirectories();
  }

  ensureDirectories() {
    if (!fs.existsSync(this.inputDir)) {
      fs.mkdirSync(this.inputDir, { recursive: true });
    }
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
  }

  async enhanceProduct(inputPath, outputPath) {
    try {
      console.log(`Processing: ${inputPath}`);
      
      // Read the original image
      const image = sharp(inputPath);
      const metadata = await image.metadata();
      
      // Create studio-quality enhancement without altering the design
      const enhanced = await image
        // Enhance contrast and brightness
        .modulate({
          brightness: 1.1,
          saturation: 1.05,
          hue: 0
        })
        // Sharpen the image for better clarity
        .sharpen({
          sigma: 1,
          flat: 1,
          jagged: 2
        })
        // Remove noise while preserving details
        .median(1)
        // Enhance colors
        .linear(1.02, -(128 * 1.02) + 128)
        // Create clean background effect
        .resize({
          width: Math.max(metadata.width, 1200),
          height: Math.max(metadata.height, 1200),
          fit: 'contain',
          background: { r: 248, g: 248, b: 248, alpha: 1 }
        })
        // Add subtle vignette for studio effect
        .composite([{
          input: await this.createVignette(Math.max(metadata.width, 1200), Math.max(metadata.height, 1200)),
          blend: 'multiply'
        }])
        // Final quality settings
        .jpeg({ quality: 95, progressive: true })
        .toBuffer();

      await fs.promises.writeFile(outputPath, enhanced);
      console.log(`✅ Enhanced: ${outputPath}`);
      
      return outputPath;
    } catch (error) {
      console.error(`❌ Error processing ${inputPath}:`, error.message);
      throw error;
    }
  }

  async createVignette(width, height) {
    // Create subtle vignette for studio lighting effect
    const vignetteBuffer = Buffer.from(
      `<svg width="${width}" height="${height}">
        <defs>
          <radialGradient id="vignette" cx="50%" cy="50%" r="70%">
            <stop offset="0%" style="stop-color:white;stop-opacity:1" />
            <stop offset="70%" style="stop-color:white;stop-opacity:1" />
            <stop offset="100%" style="stop-color:white;stop-opacity:0.95" />
          </radialGradient>
        </defs>
        <rect width="100%" height="100%" fill="url(#vignette)" />
      </svg>`
    );
    
    return vignetteBuffer;
  }

  async processAllImages() {
    try {
      const files = await fs.promises.readdir(this.inputDir);
      const imageFiles = files.filter(file => 
        /\.(jpg|jpeg|png|webp)$/i.test(file)
      );

      if (imageFiles.length === 0) {
        console.log('📁 No images found in input directory');
        console.log('💡 Add your product photos to the ./input folder');
        return;
      }

      console.log(`🔄 Processing ${imageFiles.length} images...`);
      
      for (const file of imageFiles) {
        const inputPath = path.join(this.inputDir, file);
        const outputName = `enhanced_${file.replace(/\.[^/.]+$/, '')}.jpg`;
        const outputPath = path.join(this.outputDir, outputName);
        
        await this.enhanceProduct(inputPath, outputPath);
      }
      
      console.log('🎉 All images processed successfully!');
      console.log(`📁 Check the ${this.outputDir} folder for enhanced images`);
      
    } catch (error) {
      console.error('❌ Error processing images:', error.message);
    }
  }

  async enhanceSingleImage(imagePath) {
    const filename = path.basename(imagePath, path.extname(imagePath));
    const outputPath = path.join(this.outputDir, `enhanced_${filename}.jpg`);
    return await this.enhanceProduct(imagePath, outputPath);
  }
}

async function convertToPngAndSquare(inputPath, outputPngPath) {
  console.log(`🔄 [convertToPngAndSquare] Converting ${inputPath} to 1024x1024 PNG at ${outputPngPath}`);
  await sharp(inputPath)
    .ensureAlpha() // Ensure alpha channel exists from the start
    .resize(1024, 1024, { 
      fit: 'contain', 
      background: { r: 0, g: 0, b: 0, alpha: 0 } // Use transparent background
    })
    .png({ quality: 100 }) // Ensure highest quality
    .toFile(outputPngPath);
  console.log(`✅ [convertToPngAndSquare] Saved PNG: ${outputPngPath}`);
}

async function createWhiteMask(inputPngPath, maskPath) {
  console.log(`🔄 [createWhiteMask] Creating white mask for ${inputPngPath} at ${maskPath}`);

  // Read the input image (with alpha channel)
  const input = sharp(inputPngPath);
  const { width = 1024, height = 1024 } = await input.metadata();
  // Extract alpha channel: product is opaque (alpha > 0), background is transparent (alpha == 0)
  const alpha = await input.ensureAlpha().extractChannel('alpha').toBuffer();

  // Create a white RGBA image
  const white = Buffer.alloc(width * height * 4, 255);
  // Set alpha to 0 where the product is (alpha > 0 in input), 255 elsewhere
  for (let i = 0; i < width * height; i++) {
    // If input alpha > 0, set mask alpha to 0 (transparent, don't edit)
    // Else, set mask alpha to 255 (opaque, edit)
    white[i * 4 + 3] = alpha[i] > 0 ? 0 : 255;
  }
  await sharp(white, { raw: { width, height, channels: 4 } })
    .png({ quality: 100 })
    .toFile(maskPath);
  console.log(`✅ [createWhiteMask] White mask saved: ${maskPath}`);
}

async function validateImageForDalle(imagePath) {
  const metadata = await sharp(imagePath).metadata();
  if (metadata.width !== 1024 || metadata.height !== 1024) {
    throw new Error(`Image dimensions must be 1024x1024, got ${metadata.width}x${metadata.height}`);
  }
  if (metadata.format !== 'png') {
    throw new Error(`Image must be PNG format, got ${metadata.format}`);
  }
  if (metadata.channels !== 4) {
    throw new Error(`Image must have alpha channel, got ${metadata.channels} channels`);
  }
}

async function callDalleEdit(inputPngPath, maskPath, prompt, apiKey) {
  console.log(`🔄 [callDalleEdit] Calling OpenAI API with image: ${inputPngPath}, mask: ${maskPath}`);
  const openai = new OpenAI({ apiKey });

  try {
    // Validate images before sending to DALL-E
    const inputMetadata = await sharp(inputPngPath).metadata();
    const maskMetadata = await sharp(maskPath).metadata();
    
    let finalInputPath = inputPngPath;
    let finalMaskPath = maskPath;
    
    if (inputMetadata.channels !== 4) {
      // If input doesn't have alpha channel, add it to a temp file
      const tempInputPath = inputPngPath + '.temp.png';
      await sharp(inputPngPath)
        .ensureAlpha()
        .png()
        .toFile(tempInputPath);
      finalInputPath = tempInputPath;
    }
    
    if (maskMetadata.channels !== 4) {
      // If mask doesn't have alpha channel, add it to a temp file
      const tempMaskPath = maskPath + '.temp.png';
      await sharp(maskPath)
        .ensureAlpha()
        .png()
        .toFile(tempMaskPath);
      finalMaskPath = tempMaskPath;
    }

    // Read files as buffers
    const imageBuffer = await fs.promises.readFile(finalInputPath);
    const maskBuffer = await fs.promises.readFile(finalMaskPath);
    
    // Create proper File objects with correct MIME type
    const image = new File([imageBuffer], path.basename(finalInputPath), { type: 'image/png' });
    const mask = new File([maskBuffer], path.basename(finalMaskPath), { type: 'image/png' });

    console.log(`[callDalleEdit] Prompt: ${prompt}`);
    
    // Add retry logic for DALL-E API call
    const maxRetries = 3;
    let lastError = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`[callDalleEdit] Attempt ${attempt} of ${maxRetries}`);
        
        const response = await openai.images.edit({
          image,
          mask,
          prompt,
          n: 1,
          size: '1024x1024',
          model: 'dall-e-2'
        });

        if (response.data && response.data[0] && response.data[0].url) {
          const url = response.data[0].url;
          console.log(`✅ [callDalleEdit] OpenAI returned image URL: ${url}`);
          
          // Clean up temporary files if they were created
          if (finalInputPath !== inputPngPath) {
            await fs.promises.unlink(finalInputPath);
          }
          if (finalMaskPath !== maskPath) {
            await fs.promises.unlink(finalMaskPath);
          }
          
          return url;
        } else {
          throw new Error('Invalid response format from DALL-E API');
        }
      } catch (error) {
        lastError = error;
        console.warn(`⚠️ [callDalleEdit] Attempt ${attempt} failed:`, error.message);
        
        if (attempt < maxRetries) {
          // Wait before retrying (exponential backoff)
          await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
          continue;
        }
      }
    }

    // Clean up temporary files if they were created
    if (finalInputPath !== inputPngPath) {
      await fs.promises.unlink(finalInputPath);
    }
    if (finalMaskPath !== maskPath) {
      await fs.promises.unlink(finalMaskPath);
    }

    throw lastError || new Error('All DALL-E API attempts failed');
  } catch (error) {
    console.error('❌ [callDalleEdit] Error:', error.message);
    throw error;
  }
}

async function downloadImage(url, outputPath) {
  console.log(`🔄 [downloadImage] Downloading image from: ${url}`);
  const response = await axios.get(url, { responseType: 'arraybuffer' });
  await fs.promises.writeFile(outputPath, response.data);
  console.log(`✅ [downloadImage] Image saved to: ${outputPath}`);
}

async function removeBackground(inputPath, outputPath) {
  try {
    console.log(`🔄 [removeBackground] Removing background from: ${inputPath}`);
    
    // Validate input file exists
    if (!fs.existsSync(inputPath)) {
      throw new Error(`Input file not found: ${inputPath}`);
    }

    // Validate API key
    if (!process.env.REMOVEBG_API_KEY) {
      throw new Error('REMOVEBG_API_KEY is not set in environment variables');
    }

    // Add timeout and retry logic
    const maxRetries = 3;
    let lastError = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`[removeBackground] Attempt ${attempt} of ${maxRetries}`);
        
        // Create form data
        const formData = new FormData();
        formData.append('size', 'auto');
        formData.append('image_file', fs.createReadStream(inputPath));

        const response = await axios.post('https://api.remove.bg/v1.0/removebg', formData, {
          headers: {
            'X-Api-Key': process.env.REMOVEBG_API_KEY,
            ...formData.getHeaders()
          },
          responseType: 'arraybuffer',
          timeout: 30000 // 30 second timeout
        });

        if (response.status === 200 && response.data) {
          // Save the response to a temporary file
          const tempPath = outputPath + '.temp';
          await fs.promises.writeFile(tempPath, response.data);
          
          // Process the image to ensure it has an alpha channel
          await sharp(tempPath)
            .ensureAlpha() // Ensure alpha channel exists
            .resize(1024, 1024, {
              fit: 'contain',
              background: { r: 0, g: 0, b: 0, alpha: 0 }
            })
            .png({ quality: 100 })
            .toFile(outputPath);
            
          // Clean up temporary file
          await fs.promises.unlink(tempPath);
          
          console.log(`✅ [removeBackground] Background removed and saved to: ${outputPath}`);
          return outputPath;
        }
      } catch (error) {
        lastError = error;
        console.warn(`⚠️ [removeBackground] Attempt ${attempt} failed:`, error.message);
        
        if (attempt < maxRetries) {
          // Wait before retrying (exponential backoff)
          await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
          continue;
        }
      }
    }

    // If all retries failed, use a fallback approach
    console.warn('⚠️ [removeBackground] All retry attempts failed, using fallback approach');
    
    // Fallback: Create a transparent background version
    await sharp(inputPath)
      .ensureAlpha() // Ensure alpha channel exists
      .resize(1024, 1024, { 
        fit: 'contain', 
        background: { r: 0, g: 0, b: 0, alpha: 0 } 
      })
      .png({ quality: 100 })
      .toFile(outputPath);
    
    console.log(`✅ [removeBackground] Fallback: Created transparent version at: ${outputPath}`);
    return outputPath;

  } catch (error) {
    console.error('❌ [removeBackground] Error:', error.message);
    throw error;
  }
}

// Post-process: auto-crop, center, and ensure pure white background
async function postProcessImage(inputPath, outputPath) {
  try {
    // Trim the image to the product
    const trimmedBuffer = await sharp(inputPath).trim().toBuffer();
    const trimmedMeta = await sharp(trimmedBuffer).metadata();
    // Create a white canvas
    const canvas = sharp({
      create: {
        width: 1024,
        height: 1024,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 1 }
      }
    });
    // Calculate left offset to center horizontally, top offset to align at bottom
    const left = Math.floor((1024 - trimmedMeta.width) / 2);
    const top = 1024 - trimmedMeta.height;
    // Composite trimmed product onto canvas
    await canvas
      .composite([{ input: trimmedBuffer, left, top }])
      .png({ quality: 100 })
      .toFile(outputPath);
  } catch (error) {
    console.error('❌ [postProcessImage] Error:', error.message);
    throw error;
  }
}

async function ensurePureWhiteBackground(inputPath, outputPath) {
  // Replace all near-white pixels with pure white
  const image = sharp(inputPath);
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += info.channels) {
    // If R,G,B are all above 240, set to 255 (pure white)
    if (data[i] > 240 && data[i+1] > 240 && data[i+2] > 240) {
      data[i] = 255; data[i+1] = 255; data[i+2] = 255;
    }
  }
  await sharp(data, { raw: info })
    .toFormat('png')
    .toFile(outputPath);
}

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.log('Usage: node enhance.js <input-image-path>');
    process.exit(1);
  }
  if (!process.env.OPENAI_API_KEY) {
    console.error('❌ Please set your OPENAI_API_KEY environment variable.');
    process.exit(1);
  }
  if (!process.env.REMOVEBG_API_KEY) {
    console.error('❌ Please set your REMOVEBG_API_KEY environment variable.');
    process.exit(1);
  }
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
  const filename = path.basename(inputPath, path.extname(inputPath));
  const inputPngPath = path.join(OUTPUT_DIR, `${filename}_input.png`);
  const maskPath = path.join(OUTPUT_DIR, `${filename}_mask.png`);
  const outputPath = path.join(OUTPUT_DIR, `ideal-image-result.png`);
  const noBgPath = path.join(OUTPUT_DIR, `${filename}_no_bg.png`);
  const prompt = 'Place the product at the center bottom of the image on a pure white background. No shadows, no other objects, no text, no watermark. The product should be large, clear, and well-lit, like a professional e-commerce studio photo. The background must be pure white (RGB 255,255,255).';
  try {
    console.log('🚀 [main] Starting enhancement pipeline...');
    await convertToPngAndSquare(inputPath, inputPngPath);
    await removeBackground(inputPngPath, noBgPath);
    await createWhiteMask(noBgPath, maskPath);
    const url = await callDalleEdit(noBgPath, maskPath, prompt, process.env.OPENAI_API_KEY);
    await downloadImage(url, outputPath);
    await postProcessImage(outputPath, outputPath);
    await ensurePureWhiteBackground(outputPath, outputPath);
    console.log('🎉 [main] All done! Check your enhanced images in the output folder');
  } catch (err) {
    console.error('❌ [main] Error during enhancement pipeline:', err.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

// Export for use as module
module.exports = ProductPhotoEnhancer;