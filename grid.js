import ee from '@google/earthengine';
import { draw } from './text.js';
import dotenv from 'dotenv';
import * as turf from '@turf/turf';
import geometry from './geometry.json' assert { type: 'json' }

// Run the ENV variable
dotenv.config();
const ee_key = JSON.parse(process.env.EE_KEY);
const gmaps_key = process.env.GMAPS_KEY;
const project = process.env.PROJECT;

// Authenticate and run the function
ee.data.authenticateViaPrivateKey(ee_key, () => {
	ee.initialize(null, null, () => {
		grid(geometry);
	});
});

// Main grid function
function grid(geometry){
	// Generarte box
	const bigBuffer = turf.buffer(geometry, 6);
	const extent = turf.bbox(bigBuffer);
	const box = turf.bboxPolygon(extent).geometry;

	// Generate grid
	const bounds = ee.Geometry(geometry).buffer(5000, 1e4).bounds(1e4);
	const grid = bounds.coveringGrid(ee.Projection('EPSG:3395'), 1000);

	// Get grid number
	const gridLonLat = grid.map(feat => {
		const id = feat.get('system:index');
		const list = ee.String(id).split(',');
		const x = ee.Number.parse(list.get(0));
		const y = ee.Number.parse(list.get(1));
		return feat.set('x', x, 'y', y);
	}).sort('y', false);

	// Sort properties
	const x = gridLonLat.aggregate_array('x').distinct().sort().map(num => ee.String(ee.Number(num).toInt()));
	const y = gridLonLat.aggregate_array('y').distinct().map(num => ee.String(ee.Number(num).toInt()));

	// Alphabet
	const alphabet = ee.List([ "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z" ]);

	// Grid list
	const xGrid = ee.List.sequence(0, x.size().subtract(1)).map(num => {
		num = ee.Number(num);
		const alpha = ee.Algorithms.If(ee.Number(num).lte(25), 
			alphabet.get(num),
			alphaConvert(num, alphabet)
		);
		return alpha;
	});
	const yGrid = ee.List.sequence(1, y.size()).map(num => ee.Number(num).toInt());

	// Grid dictionaries
	const xDict = ee.Dictionary.fromLists(x, xGrid);
	const yDict = ee.Dictionary.fromLists(y, yGrid);

	// Features label
	const gridLabel = ee.ImageCollection(gridLonLat.map(feat => {
		const x = feat.get('x');
		const y = feat.get('y');
		const label = ee.String(xDict.get(x)).cat(yDict.get(y));

		const centroid = feat.centroid(1e4).geometry();
		const image = draw(label, centroid, 20, { alignX: 'center', alignY: 'center', textColor: 'black', fontSize: 16 });

		return image;
	})).mosaic().visualize();

	// Convert geometry to image
	const image = ee.Image().toByte().paint(grid, 0, 1).visualize({ palette: 'black' }).blend(gridLabel);

	// Create export task
	const name = `tile_grid_${Math.round(new Date().getTime() / 1000)}`;
	const path = `tile/grid/${name}`;
	const task = ee.batch.Export.map.toCloudStorage({
		image: image,
		description: name,
		bucket: project,
		path: path,
		maxZoom: 15,
		minZoom: 0,
		region: box,
		writePublicTiles: true,
		skipEmptyTiles: true,
		bucketCorsUris: ['*'],
		mapsApiKey: gmaps_key,
	});

	// Start task
	task.start(() => {
		ee.data.listOperations(1, (list) => {
			console.log(list[0]);
		});

	}, error => console.log('Error: ' + error));
}

// Function to get the alphabet
function alphaConvert(num, alphabet){
	num = ee.Number(num);
	const divided = num.divide(26).floor().subtract(1);
	const remainder = num.mod(26);

	const first = alphabet.get(divided);
	const second = alphabet.get(remainder);

	return ee.String(first).cat(second);
}