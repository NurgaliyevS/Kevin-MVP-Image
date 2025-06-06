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
    .ensureAlpha()
    .resize(1024, 1024, { 
      fit: 'contain', 
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    })
    .png({ quality: 100 })
    .toFile(outputPngPath);
  console.log(`✅ [convertToPngAndSquare] Saved PNG: ${outputPngPath}`);
}

async function removeBackground(inputPath, outputPath) {
  try {
    console.log(`🔄 [removeBackground] Removing background from: ${inputPath}`);
    
    if (!fs.existsSync(inputPath)) {
      throw new Error(`Input file not found: ${inputPath}`);
    }

    if (!process.env.REMOVEBG_API_KEY) {
      throw new Error('REMOVEBG_API_KEY is not set in environment variables');
    }

    const maxRetries = 3;
    let lastError = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`[removeBackground] Attempt ${attempt} of ${maxRetries}`);
        
        const formData = new FormData();
        formData.append('size', 'auto');
        formData.append('image_file', fs.createReadStream(inputPath));

        const response = await axios.post('https://api.remove.bg/v1.0/removebg', formData, {
          headers: {
            'X-Api-Key': process.env.REMOVEBG_API_KEY,
            ...formData.getHeaders()
          },
          responseType: 'arraybuffer',
          timeout: 30000
        });

        if (response.status === 200 && response.data) {
          const tempPath = outputPath + '.temp';
          await fs.promises.writeFile(tempPath, response.data);
          
          await sharp(tempPath)
            .ensureAlpha()
            .resize(1024, 1024, {
              fit: 'contain',
              background: { r: 0, g: 0, b: 0, alpha: 0 }
            })
            .png({ quality: 100 })
            .toFile(outputPath);
            
          await fs.promises.unlink(tempPath);
          
          console.log(`✅ [removeBackground] Background removed and saved to: ${outputPath}`);
          return outputPath;
        }
      } catch (error) {
        lastError = error;
        console.warn(`⚠️ [removeBackground] Attempt ${attempt} failed:`, error.message);
        
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
          continue;
        }
      }
    }

    console.warn('⚠️ [removeBackground] All retry attempts failed, using fallback approach');
    
    await sharp(inputPath)
      .ensureAlpha()
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

// Create a proper mask that covers the background area, not the product
async function createBackgroundMask(inputPngPath, maskPath) {
  console.log(`🔄 [createBackgroundMask] Creating background mask for ${inputPngPath} at ${maskPath}`);
  
  const inputMetadata = await sharp(inputPngPath).metadata();
  const width = inputMetadata.width || 1024;
  const height = inputMetadata.height || 1024;

  // Read the input image to get alpha channel
  const { data, info } = await sharp(inputPngPath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Create mask data - white where transparent (background), black where opaque (product)
  const maskData = Buffer.alloc(width * height * 4);
  
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3];
    const pixelIndex = i;
    
    if (alpha < 128) { // Transparent/semi-transparent areas (background)
      maskData[pixelIndex] = 255;     // R
      maskData[pixelIndex + 1] = 255; // G
      maskData[pixelIndex + 2] = 255; // B
      maskData[pixelIndex + 3] = 255; // A
    } else { // Opaque areas (product)
      maskData[pixelIndex] = 0;       // R
      maskData[pixelIndex + 1] = 0;   // G
      maskData[pixelIndex + 2] = 0;   // B
      maskData[pixelIndex + 3] = 255; // A
    }
  }

  await sharp(maskData, {
    raw: {
      width: width,
      height: height,
      channels: 4
    }
  })
    .png({ quality: 100 })
    .toFile(maskPath);
    
  console.log(`✅ [createBackgroundMask] Background mask saved: ${maskPath}`);
}

// Position the product at center-bottom and add white background
async function repositionProduct(inputPngPath, outputPath) {
  console.log(`🔄 [repositionProduct] Repositioning product to center-bottom`);
  
  const image = sharp(inputPngPath);
  const { data, info } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  
  // Find the bounding box of the non-transparent pixels
  let minX = info.width, maxX = 0, minY = info.height, maxY = 0;
  
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const idx = (y * info.width + x) * 4;
      if (data[idx + 3] > 0) { // Non-transparent pixel
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
  }
  
  // Extract the product
  const productWidth = maxX - minX + 1;
  const productHeight = maxY - minY + 1;
  
  const croppedProduct = await sharp(inputPngPath)
    .extract({
      left: minX,
      top: minY,
      width: productWidth,
      height: productHeight
    })
    .toBuffer();
  
  // Calculate position for center-bottom (bottom 1/3 of image)
  const canvasWidth = 1024;
  const canvasHeight = 1024;
  const targetWidth = Math.min(productWidth, Math.floor(canvasWidth * 0.8)); // Max 80% of canvas width
  const targetHeight = Math.min(productHeight, Math.floor(canvasHeight * 0.6)); // Max 60% of canvas height
  
  // Resize if needed while maintaining aspect ratio
  let resizedProduct = croppedProduct;
  if (productWidth > targetWidth || productHeight > targetHeight) {
    resizedProduct = await sharp(croppedProduct)
      .resize(targetWidth, targetHeight, { fit: 'inside', withoutEnlargement: true })
      .toBuffer();
  }
  
  const resizedMeta = await sharp(resizedProduct).metadata();
  const finalWidth = resizedMeta.width;
  const finalHeight = resizedMeta.height;
  
  // Position at center-bottom
  const left = Math.round((canvasWidth - finalWidth) / 2);
  const top = Math.round(canvasHeight - finalHeight - (canvasHeight * 0.1)); // 10% from bottom
  
  // Create final image with white background
  await sharp({
    create: {
      width: canvasWidth,
      height: canvasHeight,
      channels: 3,
      background: { r: 255, g: 255, b: 255 }
    }
  })
    .composite([{
      input: resizedProduct,
      left: left,
      top: top
    }])
    .png({ quality: 100 })
    .toFile(outputPath);
    
  console.log(`✅ [repositionProduct] Product repositioned and saved to: ${outputPath}`);
}

async function callDalleEdit(inputPngPath, maskPath, prompt, apiKey) {
  console.log(`🔄 [callDalleEdit] Calling OpenAI API with image: ${inputPngPath}, mask: ${maskPath}`);
  const openai = new OpenAI({ apiKey });

  try {
    const imageBuffer = await fs.promises.readFile(inputPngPath);
    const maskBuffer = await fs.promises.readFile(maskPath);
    
    const image = new File([imageBuffer], path.basename(inputPngPath), { type: 'image/png' });
    const mask = new File([maskBuffer], path.basename(maskPath), { type: 'image/png' });

    console.log(`[callDalleEdit] Prompt: ${prompt}`);
    
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
          return url;
        } else {
          throw new Error('Invalid response format from DALL-E API');
        }
      } catch (error) {
        lastError = error;
        console.warn(`⚠️ [callDalleEdit] Attempt ${attempt} failed:`, error.message);
        
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
          continue;
        }
      }
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

// Enhanced post-processing for pure white background
async function postProcessImage(inputPath, outputPath) {
  try {
    console.log(`🔄 [postProcessImage] Post-processing image: ${inputPath}`);
    
    // Read the image
    const image = sharp(inputPath);
    const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
    
    // Process pixels to ensure pure white background
    for (let i = 0; i < data.length; i += info.channels) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      
      // If pixel is very light (near white), make it pure white
      if (r > 230 && g > 230 && b > 230) {
        data[i] = 255;     // R
        data[i + 1] = 255; // G
        data[i + 2] = 255; // B
      }
    }
    
    // Save the processed image
    await sharp(data, { raw: info })
      .png({ quality: 100 })
      .toFile(outputPath);
      
    console.log(`✅ [postProcessImage] Post-processed image saved: ${outputPath}`);
  } catch (error) {
    console.error('❌ [postProcessImage] Error:', error.message);
    throw error;
  }
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
  const noBgPath = path.join(OUTPUT_DIR, `${filename}_no_bg.png`);
  const repositionedPath = path.join(OUTPUT_DIR, `${filename}_repositioned.png`);
  const maskPath = path.join(OUTPUT_DIR, `${filename}_mask.png`);
  const dalleOutputPath = path.join(OUTPUT_DIR, `${filename}_dalle_output.png`);
  const outputPath = path.join(OUTPUT_DIR, `ideal-image-result.png`);
  
  // Updated prompt for better results
  const prompt = 'Professional e-commerce product photo with pure white background, studio lighting, no shadows, clean and minimal, product clearly visible and well-lit';

  try {
    console.log('🚀 [main] Starting enhanced pipeline...');
    
    // Step 1: Convert to PNG and resize
    await convertToPngAndSquare(inputPath, inputPngPath);
    
    // Step 2: Remove background
    await removeBackground(inputPngPath, noBgPath);
    
    // Step 3: Reposition product to center-bottom with white background
    await repositionProduct(noBgPath, repositionedPath);
    
    // Step 4: Create background mask for DALL-E
    await createBackgroundMask(noBgPath, maskPath);
    
    // Step 5: Use DALL-E to enhance the background and overall look
    const url = await callDalleEdit(repositionedPath, maskPath, prompt, process.env.OPENAI_API_KEY);
    
    // Step 6: Download the result
    await downloadImage(url, dalleOutputPath);
    
    // Step 7: Final post-processing for pure white background
    await postProcessImage(dalleOutputPath, outputPath);
    
    console.log('🎉 [main] All done! Check your enhanced image at: output/ideal-image-result.png');
    
  } catch (err) {
    console.error('❌ [main] Error during enhancement pipeline:', err.message);
    
    // Fallback: If DALL-E fails, use the repositioned version
    try {
      console.log('🔄 [main] Using fallback approach...');
      if (fs.existsSync(repositionedPath)) {
        await fs.promises.copyFile(repositionedPath, outputPath);
        console.log('✅ [main] Fallback image saved to: output/ideal-image-result.png');
      }
    } catch (fallbackError) {
      console.error('❌ [main] Fallback also failed:', fallbackError.message);
    }
    
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = ProductPhotoEnhancer;