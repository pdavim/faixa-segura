import type { LandClass, LatLon, MunicipalityInfo, ParcelRecord, PirLevel } from '../types/domain.ts';
import { PORTUGAL_PARISHES_BY_DICO } from './portugalParishesByDico.ts';

export { PORTUGAL_PARISHES_BY_DICO };
export const CUSTOM_USER_INPUT_VALUE = '__USER_INPUT__';

export interface SelectOptionItem {
  value: string;
  label: string;
}

export const PORTUGAL_DISTRICTS: readonly string[] = [
  'Aveiro',
  'Beja',
  'Braga',
  'Bragança',
  'Castelo Branco',
  'Coimbra',
  'Évora',
  'Faro',
  'Guarda',
  'Leiria',
  'Lisboa',
  'Portalegre',
  'Porto',
  'Santarém',
  'Setúbal',
  'Viana do Castelo',
  'Vila Real',
  'Viseu',
  'Região Autónoma dos Açores',
  'Região Autónoma da Madeira',
] as const;

const DISTRICT_CENTERS: Record<
  string,
  {
    lat: number;
    lon: number;
    regionGroup: 'AML' | 'AMP' | 'CENTRO_NORTE';
    pir: [PirLevel, PirLevel, PirLevel];
  }
> = {
  Aveiro: { lat: 40.6405, lon: -8.6538, regionGroup: 'CENTRO_NORTE', pir: [3, 2, 2] },
  Beja: { lat: 38.0151, lon: -7.8632, regionGroup: 'CENTRO_NORTE', pir: [4, 4, 3] },
  Braga: { lat: 41.5454, lon: -8.4265, regionGroup: 'CENTRO_NORTE', pir: [2, 3, 2] },
  Bragança: { lat: 41.8061, lon: -6.7567, regionGroup: 'CENTRO_NORTE', pir: [4, 4, 3] },
  'Castelo Branco': { lat: 39.8222, lon: -7.4909, regionGroup: 'CENTRO_NORTE', pir: [5, 4, 4] },
  Coimbra: { lat: 40.2033, lon: -8.4103, regionGroup: 'CENTRO_NORTE', pir: [3, 3, 2] },
  Évora: { lat: 38.5714, lon: -7.9135, regionGroup: 'CENTRO_NORTE', pir: [4, 4, 3] },
  Faro: { lat: 37.0194, lon: -7.9304, regionGroup: 'CENTRO_NORTE', pir: [4, 4, 3] },
  Guarda: { lat: 40.5373, lon: -7.2658, regionGroup: 'CENTRO_NORTE', pir: [4, 4, 3] },
  Leiria: { lat: 39.7438, lon: -8.8071, regionGroup: 'CENTRO_NORTE', pir: [4, 4, 3] },
  Lisboa: { lat: 38.7223, lon: -9.1393, regionGroup: 'AML', pir: [3, 3, 2] },
  Portalegre: { lat: 39.2967, lon: -7.4285, regionGroup: 'CENTRO_NORTE', pir: [4, 4, 3] },
  Porto: { lat: 41.1579, lon: -8.6291, regionGroup: 'AMP', pir: [3, 3, 2] },
  Santarém: { lat: 39.2369, lon: -8.685, regionGroup: 'CENTRO_NORTE', pir: [4, 4, 3] },
  Setúbal: { lat: 38.5244, lon: -8.8882, regionGroup: 'AML', pir: [4, 4, 3] },
  'Viana do Castelo': { lat: 41.6918, lon: -8.8344, regionGroup: 'CENTRO_NORTE', pir: [2, 3, 2] },
  'Vila Real': { lat: 41.3006, lon: -7.7441, regionGroup: 'CENTRO_NORTE', pir: [4, 4, 3] },
  Viseu: { lat: 40.6566, lon: -7.9125, regionGroup: 'CENTRO_NORTE', pir: [3, 4, 2] },
  'Região Autónoma dos Açores': {
    lat: 37.7412,
    lon: -25.6756,
    regionGroup: 'CENTRO_NORTE',
    pir: [1, 2, 1],
  },
  'Região Autónoma da Madeira': {
    lat: 32.6669,
    lon: -16.9241,
    regionGroup: 'CENTRO_NORTE',
    pir: [3, 3, 2],
  },
};

interface RawMunicipalityDef {
  dico: string;
  name: string;
  center?: LatLon;
  dicofreDefault?: string;
  pir?: [PirLevel, PirLevel, PirLevel];
}

const RAW_MUNICIPALITIES_BY_DISTRICT: Record<string, RawMunicipalityDef[]> = {
  Aveiro: [
    {
      dico: '0101',
      name: 'Águeda',
      dicofreDefault: '010121',
      center: { lat: 40.5744, lon: -8.4481 },
      pir: [3, 2, 2],
    },
    { dico: '0102', name: 'Albergaria-a-Velha', center: { lat: 40.6933, lon: -8.4806 } },
    { dico: '0103', name: 'Anadia', center: { lat: 40.4408, lon: -8.435 } },
    { dico: '0104', name: 'Arouca', center: { lat: 40.9288, lon: -8.2452 } },
    { dico: '0105', name: 'Aveiro', center: { lat: 40.6405, lon: -8.6538 } },
    { dico: '0106', name: 'Castelo de Paiva', center: { lat: 41.0422, lon: -8.2706 } },
    { dico: '0107', name: 'Espinho', center: { lat: 41.0072, lon: -8.6413 } },
    { dico: '0108', name: 'Estarreja', center: { lat: 40.7528, lon: -8.5711 } },
    { dico: '0109', name: 'Santa Maria da Feira', center: { lat: 40.9254, lon: -8.5428 } },
    { dico: '0110', name: 'Ílhavo', center: { lat: 40.6019, lon: -8.6694 } },
    { dico: '0111', name: 'Mealhada', center: { lat: 40.3781, lon: -8.4519 } },
    { dico: '0112', name: 'Murtosa', center: { lat: 40.7372, lon: -8.6386 } },
    { dico: '0113', name: 'Oliveira de Azeméis', center: { lat: 40.8389, lon: -8.4775 } },
    { dico: '0114', name: 'Oliveira do Bairro', center: { lat: 40.5144, lon: -8.4936 } },
    { dico: '0115', name: 'Ovar', center: { lat: 40.8596, lon: -8.6253 } },
    { dico: '0116', name: 'São João da Madeira', center: { lat: 40.9006, lon: -8.4907 } },
    { dico: '0117', name: 'Sever do Vouga', center: { lat: 40.7339, lon: -8.3694 } },
    { dico: '0118', name: 'Vagos', center: { lat: 40.5553, lon: -8.6814 } },
    { dico: '0119', name: 'Vale de Cambra', center: { lat: 40.8439, lon: -8.3958 } },
  ],
  Beja: [
    { dico: '0201', name: 'Aljustrel', center: { lat: 37.8775, lon: -8.165 } },
    { dico: '0202', name: 'Almodôvar', center: { lat: 37.5114, lon: -8.0603 } },
    { dico: '0203', name: 'Alvito', center: { lat: 38.2575, lon: -7.9919 } },
    { dico: '0204', name: 'Barrancos', center: { lat: 38.1314, lon: -6.9767 } },
    { dico: '0205', name: 'Beja', center: { lat: 38.0151, lon: -7.8632 } },
    { dico: '0206', name: 'Castro Verde', center: { lat: 37.6983, lon: -8.0858 } },
    { dico: '0207', name: 'Cuba', center: { lat: 38.165, lon: -7.8922 } },
    { dico: '0208', name: 'Ferreira do Alentejo', center: { lat: 38.0586, lon: -8.1158 } },
    { dico: '0209', name: 'Mértola', center: { lat: 37.6383, lon: -7.6619 } },
    { dico: '0210', name: 'Moura', center: { lat: 38.1401, lon: -7.4486 } },
    { dico: '0211', name: 'Odemira', center: { lat: 37.5967, lon: -8.64 } },
    { dico: '0212', name: 'Ourique', center: { lat: 37.6517, lon: -8.225 } },
    { dico: '0213', name: 'Serpa', center: { lat: 37.9442, lon: -7.5975 } },
    { dico: '0214', name: 'Vidigueira', center: { lat: 38.2097, lon: -7.8011 } },
  ],
  Braga: [
    { dico: '0301', name: 'Amares', center: { lat: 41.6314, lon: -8.3514 } },
    { dico: '0302', name: 'Barcelos', center: { lat: 41.5319, lon: -8.6189 } },
    { dico: '0303', name: 'Braga', center: { lat: 41.5454, lon: -8.4265 } },
    { dico: '0304', name: 'Cabeceiras de Basto', center: { lat: 41.5139, lon: -7.9922 } },
    { dico: '0305', name: 'Celorico de Basto', center: { lat: 41.3869, lon: -8.0019 } },
    { dico: '0306', name: 'Esposende', center: { lat: 41.5322, lon: -8.7811 } },
    { dico: '0307', name: 'Fafe', center: { lat: 41.4519, lon: -8.1722 } },
    { dico: '0308', name: 'Guimarães', center: { lat: 41.4425, lon: -8.2918 } },
    { dico: '0309', name: 'Póvoa de Lanhoso', center: { lat: 41.5764, lon: -8.2711 } },
    {
      dico: '0310',
      name: 'Terras de Bouro',
      dicofreDefault: '031018',
      center: { lat: 41.7168, lon: -8.3092 },
      pir: [2, 3, 2],
    },
    { dico: '0311', name: 'Vieira do Minho', center: { lat: 41.6339, lon: -8.1369 } },
    { dico: '0312', name: 'Vila Nova de Famalicão', center: { lat: 41.4081, lon: -8.5198 } },
    { dico: '0313', name: 'Vila Verde', center: { lat: 41.6481, lon: -8.4356 } },
    { dico: '0314', name: 'Vizela', center: { lat: 41.3772, lon: -8.3089 } },
  ],
  Bragança: [
    { dico: '0401', name: 'Alfândega da Fé', center: { lat: 41.3439, lon: -6.9608 } },
    { dico: '0402', name: 'Bragança', center: { lat: 41.8061, lon: -6.7567 } },
    { dico: '0403', name: 'Carrazeda de Ansiães', center: { lat: 41.2428, lon: -7.3056 } },
    { dico: '0404', name: 'Freixo de Espada à Cinta', center: { lat: 41.0914, lon: -6.8069 } },
    { dico: '0405', name: 'Macedo de Cavaleiros', center: { lat: 41.5383, lon: -6.9611 } },
    { dico: '0406', name: 'Miranda do Douro', center: { lat: 41.4969, lon: -6.2731 } },
    { dico: '0407', name: 'Mirandela', center: { lat: 41.4853, lon: -7.1819 } },
    { dico: '0408', name: 'Mogadouro', center: { lat: 41.3403, lon: -6.7119 } },
    { dico: '0409', name: 'Torre de Moncorvo', center: { lat: 41.1742, lon: -7.0531 } },
    { dico: '0410', name: 'Vila Flor', center: { lat: 41.3075, lon: -7.1522 } },
    { dico: '0411', name: 'Vimioso', center: { lat: 41.5839, lon: -6.5278 } },
    { dico: '0412', name: 'Vinhais', center: { lat: 41.8347, lon: -7.0031 } },
  ],
  'Castelo Branco': [
    { dico: '0501', name: 'Belmonte', center: { lat: 40.3583, lon: -7.3514 } },
    { dico: '0502', name: 'Castelo Branco', center: { lat: 39.8222, lon: -7.4909 } },
    { dico: '0503', name: 'Covilhã', center: { lat: 40.2806, lon: -7.5043 } },
    { dico: '0504', name: 'Fundão', center: { lat: 40.1403, lon: -7.5014 } },
    { dico: '0505', name: 'Idanha-a-Nova', center: { lat: 39.9219, lon: -7.2367 } },
    { dico: '0506', name: 'Oleiros', center: { lat: 39.9189, lon: -7.9139 } },
    { dico: '0507', name: 'Penamacor', center: { lat: 40.1689, lon: -7.1706 } },
    {
      dico: '0508',
      name: 'Proença-a-Nova',
      dicofreDefault: '050804',
      center: { lat: 39.7495, lon: -7.9238 },
      pir: [5, 5, 4],
    },
    { dico: '0509', name: 'Sertã', center: { lat: 39.8008, lon: -8.0989 } },
    { dico: '0510', name: 'Vila de Rei', center: { lat: 39.6769, lon: -8.1464 } },
    { dico: '0511', name: 'Vila Velha de Ródão', center: { lat: 39.6547, lon: -7.6714 } },
  ],
  Coimbra: [
    { dico: '0601', name: 'Arganil', center: { lat: 40.2183, lon: -8.0539 } },
    { dico: '0602', name: 'Cantanhede', center: { lat: 40.3464, lon: -8.5942 } },
    {
      dico: '0603',
      name: 'Coimbra',
      dicofreDefault: '060334',
      center: { lat: 40.2185, lon: -8.3962 },
      pir: [3, 3, 2],
    },
    { dico: '0604', name: 'Condeixa-a-Nova', center: { lat: 40.1125, lon: -8.4989 } },
    { dico: '0605', name: 'Figueira da Foz', center: { lat: 40.1508, lon: -8.8618 } },
    { dico: '0606', name: 'Góis', center: { lat: 40.1544, lon: -8.1106 } },
    { dico: '0607', name: 'Lousã', center: { lat: 40.1125, lon: -8.2469 } },
    { dico: '0608', name: 'Mira', center: { lat: 40.4286, lon: -8.7364 } },
    { dico: '0609', name: 'Miranda do Corvo', center: { lat: 40.0931, lon: -8.3325 } },
    { dico: '0610', name: 'Montemor-o-Velho', center: { lat: 40.1744, lon: -8.6839 } },
    { dico: '0611', name: 'Oliveira do Hospital', center: { lat: 40.3592, lon: -7.8617 } },
    { dico: '0612', name: 'Pampilhosa da Serra', center: { lat: 40.0469, lon: -7.9519 } },
    { dico: '0613', name: 'Penacova', center: { lat: 40.2706, lon: -8.2825 } },
    { dico: '0614', name: 'Penela', center: { lat: 40.0308, lon: -8.3906 } },
    { dico: '0615', name: 'Soure', center: { lat: 40.0589, lon: -8.6261 } },
    { dico: '0616', name: 'Tábua', center: { lat: 40.3608, lon: -8.0289 } },
    { dico: '0617', name: 'Vila Nova de Poiares', center: { lat: 40.2108, lon: -8.2586 } },
  ],
  Évora: [
    { dico: '0701', name: 'Alandroal', center: { lat: 38.7022, lon: -7.4033 } },
    { dico: '0702', name: 'Arraiolos', center: { lat: 38.7236, lon: -7.9847 } },
    { dico: '0703', name: 'Borba', center: { lat: 38.8058, lon: -7.4547 } },
    { dico: '0704', name: 'Estremoz', center: { lat: 38.8431, lon: -7.5881 } },
    { dico: '0705', name: 'Évora', center: { lat: 38.5714, lon: -7.9135 } },
    { dico: '0706', name: 'Montemor-o-Novo', center: { lat: 38.6486, lon: -8.2156 } },
    { dico: '0707', name: 'Mora', center: { lat: 38.9442, lon: -8.1636 } },
    { dico: '0708', name: 'Mourão', center: { lat: 38.3828, lon: -7.3444 } },
    { dico: '0709', name: 'Portel', center: { lat: 38.3086, lon: -7.7031 } },
    { dico: '0710', name: 'Redondo', center: { lat: 38.6475, lon: -7.5469 } },
    { dico: '0711', name: 'Reguengos de Monsaraz', center: { lat: 38.425, lon: -7.5347 } },
    { dico: '0712', name: 'Vendas Novas', center: { lat: 38.6772, lon: -8.4578 } },
    { dico: '0713', name: 'Viana do Alentejo', center: { lat: 38.3333, lon: -8.0014 } },
    { dico: '0714', name: 'Vila Viçosa', center: { lat: 38.7789, lon: -7.4175 } },
  ],
  Faro: [
    { dico: '0801', name: 'Albufeira', center: { lat: 37.0891, lon: -8.2479 } },
    { dico: '0802', name: 'Alcoutim', center: { lat: 37.4717, lon: -7.4722 } },
    { dico: '0803', name: 'Aljezur', center: { lat: 37.3192, lon: -8.8033 } },
    { dico: '0804', name: 'Castro Marim', center: { lat: 37.2189, lon: -7.4433 } },
    { dico: '0805', name: 'Faro', center: { lat: 37.0194, lon: -7.9304 } },
    { dico: '0806', name: 'Lagoa', center: { lat: 37.1356, lon: -8.4525 } },
    { dico: '0807', name: 'Lagos', center: { lat: 37.1028, lon: -8.673 } },
    { dico: '0808', name: 'Loulé', center: { lat: 37.1378, lon: -8.0197 } },
    { dico: '0809', name: 'Monchique', center: { lat: 37.3169, lon: -8.5553 } },
    { dico: '0810', name: 'Olhão', center: { lat: 37.0286, lon: -7.8411 } },
    { dico: '0811', name: 'Portimão', center: { lat: 37.1362, lon: -8.5377 } },
    { dico: '0812', name: 'São Brás de Alportel', center: { lat: 37.1517, lon: -7.8878 } },
    { dico: '0813', name: 'Silves', center: { lat: 37.1892, lon: -8.4383 } },
    { dico: '0814', name: 'Tavira', center: { lat: 37.1273, lon: -7.6486 } },
    { dico: '0815', name: 'Vila do Bispo', center: { lat: 37.0828, lon: -8.9119 } },
    { dico: '0816', name: 'Vila Real de Santo António', center: { lat: 37.1944, lon: -7.4178 } },
  ],
  Guarda: [
    { dico: '0901', name: 'Aguiar da Beira', center: { lat: 40.8178, lon: -7.5419 } },
    { dico: '0902', name: 'Almeida', center: { lat: 40.7258, lon: -6.9061 } },
    { dico: '0903', name: 'Celorico da Beira', center: { lat: 40.6361, lon: -7.3919 } },
    { dico: '0904', name: 'Figueira de Castelo Rodrigo', center: { lat: 40.8944, lon: -6.9639 } },
    { dico: '0905', name: 'Fornos de Algodres', center: { lat: 40.6208, lon: -7.5392 } },
    { dico: '0906', name: 'Gouveia', center: { lat: 40.4939, lon: -7.5931 } },
    { dico: '0907', name: 'Guarda', center: { lat: 40.5373, lon: -7.2658 } },
    { dico: '0908', name: 'Manteigas', center: { lat: 40.4028, lon: -7.5397 } },
    { dico: '0909', name: 'Mêda', center: { lat: 40.9636, lon: -7.2625 } },
    { dico: '0910', name: 'Pinhel', center: { lat: 40.7756, lon: -7.0628 } },
    { dico: '0911', name: 'Sabugal', center: { lat: 40.3514, lon: -7.0911 } },
    { dico: '0912', name: 'Seia', center: { lat: 40.415, lon: -7.7033 } },
    { dico: '0913', name: 'Trancoso', center: { lat: 40.7783, lon: -7.3492 } },
    { dico: '0914', name: 'Vila Nova de Foz Côa', center: { lat: 41.0828, lon: -7.1364 } },
  ],
  Leiria: [
    { dico: '1001', name: 'Alcobaça', center: { lat: 39.5489, lon: -8.9775 } },
    { dico: '1002', name: 'Alvaiázere', center: { lat: 39.8228, lon: -8.3806 } },
    { dico: '1003', name: 'Ansião', center: { lat: 39.9119, lon: -8.4356 } },
    { dico: '1004', name: 'Batalha', center: { lat: 39.6603, lon: -8.8247 } },
    { dico: '1005', name: 'Bombarral', center: { lat: 39.2675, lon: -9.1578 } },
    { dico: '1006', name: 'Caldas da Rainha', center: { lat: 39.4033, lon: -9.1383 } },
    { dico: '1007', name: 'Castanheira de Pêra', center: { lat: 40.0069, lon: -8.2108 } },
    {
      dico: '1008',
      name: 'Figueiró dos Vinhos',
      dicofreDefault: '100806',
      center: { lat: 39.9018, lon: -8.2764 },
      pir: [5, 4, 3],
    },
    {
      dico: '1009',
      name: 'Leiria',
      dicofreDefault: '100933',
      center: { lat: 39.74381, lon: -8.807125 },
      pir: [4, 5, 3],
    },
    { dico: '1010', name: 'Marinha Grande', center: { lat: 39.7478, lon: -8.9322 } },
    { dico: '1011', name: 'Nazaré', center: { lat: 39.6019, lon: -9.0706 } },
    { dico: '1012', name: 'Óbidos', center: { lat: 39.3605, lon: -9.1567 } },
    { dico: '1013', name: 'Pedrógão Grande', center: { lat: 39.9169, lon: -8.1469 } },
    { dico: '1014', name: 'Peniche', center: { lat: 39.3558, lon: -9.3811 } },
    { dico: '1015', name: 'Pombal', center: { lat: 39.9158, lon: -8.6281 } },
    { dico: '1016', name: 'Porto de Mós', center: { lat: 39.6019, lon: -8.8178 } },
  ],
  Lisboa: [
    { dico: '1101', name: 'Alenquer', center: { lat: 39.0533, lon: -9.0092 } },
    { dico: '1102', name: 'Arruda dos Vinhos', center: { lat: 38.9842, lon: -9.0775 } },
    { dico: '1103', name: 'Azambuja', center: { lat: 39.0703, lon: -8.8681 } },
    { dico: '1104', name: 'Cadaval', center: { lat: 39.2428, lon: -9.1033 } },
    { dico: '1105', name: 'Cascais', center: { lat: 38.6979, lon: -9.4215 } },
    { dico: '1106', name: 'Lisboa', center: { lat: 38.7223, lon: -9.1393 } },
    { dico: '1107', name: 'Loures', center: { lat: 38.8309, lon: -9.1684 } },
    { dico: '1108', name: 'Lourinhã', center: { lat: 39.2431, lon: -9.3125 } },
    {
      dico: '1109',
      name: 'Mafra',
      dicofreDefault: '110909',
      center: { lat: 38.9482, lon: -9.3185 },
      pir: [3, 4, 2],
    },
    { dico: '1110', name: 'Oeiras', center: { lat: 38.691, lon: -9.3109 } },
    {
      dico: '1111',
      name: 'Sintra',
      dicofreDefault: '111105',
      center: { lat: 38.798412, lon: -9.462108 },
      pir: [4, 3, 2],
    },
    { dico: '1112', name: 'Sobral de Monte Agraço', center: { lat: 39.0186, lon: -9.1511 } },
    { dico: '1113', name: 'Torres Vedras', center: { lat: 39.0911, lon: -9.2586 } },
    { dico: '1114', name: 'Vila Franca de Xira', center: { lat: 38.9553, lon: -8.9897 } },
    { dico: '1115', name: 'Amadora', center: { lat: 38.7538, lon: -9.2308 } },
    { dico: '1116', name: 'Odivelas', center: { lat: 38.7927, lon: -9.1838 } },
  ],
  Portalegre: [
    { dico: '1201', name: 'Alter do Chão', center: { lat: 39.1992, lon: -7.6589 } },
    { dico: '1202', name: 'Arronches', center: { lat: 39.1225, lon: -7.2856 } },
    { dico: '1203', name: 'Avis', center: { lat: 39.0564, lon: -7.8914 } },
    { dico: '1204', name: 'Campo Maior', center: { lat: 39.0125, lon: -7.0686 } },
    { dico: '1205', name: 'Castelo de Vide', center: { lat: 39.4161, lon: -7.4558 } },
    { dico: '1206', name: 'Crato', center: { lat: 39.2869, lon: -7.6442 } },
    { dico: '1207', name: 'Elvas', center: { lat: 38.8815, lon: -7.1628 } },
    { dico: '1208', name: 'Fronteira', center: { lat: 39.0569, lon: -7.6475 } },
    { dico: '1209', name: 'Gavião', center: { lat: 39.4647, lon: -7.9358 } },
    { dico: '1210', name: 'Marvão', center: { lat: 39.3939, lon: -7.3767 } },
    { dico: '1211', name: 'Monforte', center: { lat: 39.0539, lon: -7.4389 } },
    { dico: '1212', name: 'Nisa', center: { lat: 39.5169, lon: -7.6486 } },
    { dico: '1213', name: 'Ponte de Sor', center: { lat: 39.2494, lon: -8.0106 } },
    { dico: '1214', name: 'Portalegre', center: { lat: 39.2967, lon: -7.4285 } },
    { dico: '1215', name: 'Sousel', center: { lat: 38.9531, lon: -7.6756 } },
  ],
  Porto: [
    { dico: '1301', name: 'Amarante', center: { lat: 41.2703, lon: -8.0819 } },
    { dico: '1302', name: 'Baião', center: { lat: 41.1619, lon: -8.0342 } },
    { dico: '1303', name: 'Felgueiras', center: { lat: 41.3664, lon: -8.1975 } },
    { dico: '1304', name: 'Gondomar', center: { lat: 41.1444, lon: -8.5322 } },
    { dico: '1305', name: 'Lousada', center: { lat: 41.2775, lon: -8.2836 } },
    { dico: '1306', name: 'Maia', center: { lat: 41.2357, lon: -8.6199 } },
    { dico: '1307', name: 'Marco de Canaveses', center: { lat: 41.1856, lon: -8.1494 } },
    { dico: '1308', name: 'Matosinhos', center: { lat: 41.182, lon: -8.689 } },
    { dico: '1309', name: 'Paços de Ferreira', center: { lat: 41.2769, lon: -8.3758 } },
    {
      dico: '1310',
      name: 'Paredes',
      dicofreDefault: '131013',
      center: { lat: 41.2054, lon: -8.3308 },
      pir: [3, 4, 3],
    },
    { dico: '1311', name: 'Penafiel', center: { lat: 41.2081, lon: -8.2839 } },
    { dico: '1312', name: 'Porto', center: { lat: 41.1579, lon: -8.6291 } },
    { dico: '1313', name: 'Póvoa de Varzim', center: { lat: 41.3804, lon: -8.7609 } },
    { dico: '1314', name: 'Santo Tirso', center: { lat: 41.3431, lon: -8.4775 } },
    {
      dico: '1315',
      name: 'Valongo',
      dicofreDefault: '131505',
      center: { lat: 41.1862, lon: -8.4988 },
      pir: [3, 2, 2],
    },
    { dico: '1316', name: 'Vila do Conde', center: { lat: 41.3542, lon: -8.7439 } },
    { dico: '1317', name: 'Vila Nova de Gaia', center: { lat: 41.1239, lon: -8.6118 } },
    { dico: '1318', name: 'Trofa', center: { lat: 41.3389, lon: -8.56 } },
  ],
  Santarém: [
    { dico: '1401', name: 'Abrantes', center: { lat: 39.4631, lon: -8.1978 } },
    { dico: '1402', name: 'Alcanena', center: { lat: 39.4592, lon: -8.6689 } },
    { dico: '1403', name: 'Almeirim', center: { lat: 39.2086, lon: -8.6269 } },
    { dico: '1404', name: 'Alpiarça', center: { lat: 39.2575, lon: -8.5831 } },
    { dico: '1405', name: 'Benavente', center: { lat: 38.9819, lon: -8.8106 } },
    { dico: '1406', name: 'Cartaxo', center: { lat: 39.1608, lon: -8.7875 } },
    { dico: '1407', name: 'Chamusca', center: { lat: 39.3569, lon: -8.4814 } },
    { dico: '1408', name: 'Constância', center: { lat: 39.4761, lon: -8.3389 } },
    { dico: '1409', name: 'Coruche', center: { lat: 38.9589, lon: -8.5269 } },
    { dico: '1410', name: 'Entroncamento', center: { lat: 39.465, lon: -8.4686 } },
    { dico: '1411', name: 'Ferreira do Zêzere', center: { lat: 39.6936, lon: -8.2908 } },
    { dico: '1412', name: 'Golegã', center: { lat: 39.4028, lon: -8.4864 } },
    { dico: '1413', name: 'Mação', center: { lat: 39.5558, lon: -7.9958 } },
    { dico: '1414', name: 'Rio Maior', center: { lat: 39.3369, lon: -8.9364 } },
    { dico: '1415', name: 'Salvaterra de Magos', center: { lat: 39.0269, lon: -8.7919 } },
    { dico: '1416', name: 'Santarém', center: { lat: 39.2369, lon: -8.685 } },
    { dico: '1417', name: 'Sardoal', center: { lat: 39.5356, lon: -8.1614 } },
    { dico: '1418', name: 'Torres Novas', center: { lat: 39.4806, lon: -8.5394 } },
    {
      dico: '1419',
      name: 'Tomar',
      dicofreDefault: '141908',
      center: { lat: 39.6035, lon: -8.4092 },
      pir: [4, 4, 3],
    },
    { dico: '1420', name: 'Vila Nova da Barquinha', center: { lat: 39.4586, lon: -8.4314 } },
    { dico: '1421', name: 'Ourém', center: { lat: 39.6556, lon: -8.5819 } },
  ],
  Setúbal: [
    { dico: '1501', name: 'Alcácer do Sal', center: { lat: 38.3725, lon: -8.5139 } },
    { dico: '1502', name: 'Alcochete', center: { lat: 38.7553, lon: -8.9608 } },
    { dico: '1503', name: 'Almada', center: { lat: 38.6765, lon: -9.1551 } },
    { dico: '1504', name: 'Barreiro', center: { lat: 38.6631, lon: -9.0725 } },
    { dico: '1505', name: 'Grândola', center: { lat: 38.1769, lon: -8.5675 } },
    { dico: '1506', name: 'Moita', center: { lat: 38.6508, lon: -8.9911 } },
    { dico: '1507', name: 'Montijo', center: { lat: 38.7069, lon: -8.9739 } },
    {
      dico: '1508',
      name: 'Palmela',
      dicofreDefault: '150804',
      center: { lat: 38.5688, lon: -8.9012 },
      pir: [4, 4, 3],
    },
    { dico: '1509', name: 'Santiago do Cacém', center: { lat: 38.0169, lon: -8.6947 } },
    { dico: '1510', name: 'Seixal', center: { lat: 38.6406, lon: -9.1014 } },
    { dico: '1511', name: 'Sesimbra', center: { lat: 38.4444, lon: -9.1014 } },
    { dico: '1512', name: 'Setúbal', center: { lat: 38.5244, lon: -8.8882 } },
    { dico: '1513', name: 'Sines', center: { lat: 37.9564, lon: -8.8697 } },
  ],
  'Viana do Castelo': [
    { dico: '1601', name: 'Arcos de Valdevez', center: { lat: 41.8469, lon: -8.4192 } },
    { dico: '1602', name: 'Caminha', center: { lat: 41.8756, lon: -8.8383 } },
    { dico: '1603', name: 'Melgaço', center: { lat: 42.1139, lon: -8.2597 } },
    { dico: '1604', name: 'Monção', center: { lat: 42.0772, lon: -8.4814 } },
    { dico: '1605', name: 'Paredes de Coura', center: { lat: 41.9125, lon: -8.5608 } },
    { dico: '1606', name: 'Ponte da Barca', center: { lat: 41.8075, lon: -8.4189 } },
    { dico: '1607', name: 'Ponte de Lima', center: { lat: 41.7672, lon: -8.5839 } },
    { dico: '1608', name: 'Valença', center: { lat: 42.0289, lon: -8.6428 } },
    { dico: '1609', name: 'Viana do Castelo', center: { lat: 41.6918, lon: -8.8344 } },
    { dico: '1610', name: 'Vila Nova de Cerveira', center: { lat: 41.9411, lon: -8.7425 } },
  ],
  'Vila Real': [
    { dico: '1701', name: 'Alijó', center: { lat: 41.2764, lon: -7.4747 } },
    { dico: '1702', name: 'Boticas', center: { lat: 41.6886, lon: -7.6661 } },
    { dico: '1703', name: 'Chaves', center: { lat: 41.7406, lon: -7.4706 } },
    { dico: '1704', name: 'Mesão Frio', center: { lat: 41.1586, lon: -7.8894 } },
    { dico: '1705', name: 'Mondim de Basto', center: { lat: 41.4125, lon: -7.9542 } },
    { dico: '1706', name: 'Montalegre', center: { lat: 41.8236, lon: -7.7897 } },
    { dico: '1707', name: 'Murça', center: { lat: 41.4067, lon: -7.4525 } },
    { dico: '1708', name: 'Peso da Régua', center: { lat: 41.1636, lon: -7.7889 } },
    { dico: '1709', name: 'Ribeira de Pena', center: { lat: 41.5194, lon: -7.7942 } },
    { dico: '1710', name: 'Sabrosa', center: { lat: 41.2669, lon: -7.5758 } },
    { dico: '1711', name: 'Santa Marta de Penaguião', center: { lat: 41.2108, lon: -7.7847 } },
    { dico: '1712', name: 'Valpaços', center: { lat: 41.6075, lon: -7.3108 } },
    { dico: '1713', name: 'Vila Pouca de Aguiar', center: { lat: 41.5006, lon: -7.6425 } },
    { dico: '1714', name: 'Vila Real', center: { lat: 41.3006, lon: -7.7441 } },
  ],
  Viseu: [
    { dico: '1801', name: 'Armamar', center: { lat: 41.1092, lon: -7.6928 } },
    { dico: '1802', name: 'Carregal do Sal', center: { lat: 40.4331, lon: -7.9997 } },
    { dico: '1803', name: 'Castro Daire', center: { lat: 40.8986, lon: -7.9333 } },
    { dico: '1804', name: 'Cinfães', center: { lat: 41.0731, lon: -8.0886 } },
    { dico: '1805', name: 'Lamego', center: { lat: 41.0975, lon: -7.8097 } },
    { dico: '1806', name: 'Mangualde', center: { lat: 40.6042, lon: -7.7611 } },
    { dico: '1807', name: 'Moimenta da Beira', center: { lat: 40.9819, lon: -7.6156 } },
    { dico: '1808', name: 'Mortágua', center: { lat: 40.3961, lon: -8.2306 } },
    { dico: '1809', name: 'Nelas', center: { lat: 40.5311, lon: -7.8511 } },
    { dico: '1810', name: 'Oliveira de Frades', center: { lat: 40.7336, lon: -8.1736 } },
    { dico: '1811', name: 'Penalva do Castelo', center: { lat: 40.6772, lon: -7.6983 } },
    { dico: '1812', name: 'Penedono', center: { lat: 40.9889, lon: -7.3942 } },
    { dico: '1813', name: 'Resende', center: { lat: 41.1056, lon: -7.9617 } },
    { dico: '1814', name: 'Santa Comba Dão', center: { lat: 40.3975, lon: -8.1306 } },
    { dico: '1815', name: 'São João da Pesqueira', center: { lat: 41.1475, lon: -7.4047 } },
    { dico: '1816', name: 'São Pedro do Sul', center: { lat: 40.7586, lon: -8.0669 } },
    { dico: '1817', name: 'Sátão', center: { lat: 40.7422, lon: -7.7325 } },
    { dico: '1818', name: 'Sernancelhe', center: { lat: 40.9003, lon: -7.4944 } },
    { dico: '1819', name: 'Tabuaço', center: { lat: 41.1167, lon: -7.5675 } },
    { dico: '1820', name: 'Tarouca', center: { lat: 41.0169, lon: -7.775 } },
    { dico: '1821', name: 'Tondela', center: { lat: 40.5169, lon: -8.0808 } },
    { dico: '1822', name: 'Vila Nova de Paiva', center: { lat: 40.85, lon: -7.7289 } },
    {
      dico: '1823',
      name: 'Viseu',
      dicofreDefault: '182315',
      center: { lat: 40.661, lon: -7.9097 },
      pir: [3, 4, 2],
    },
    { dico: '1824', name: 'Vouzela', center: { lat: 40.7231, lon: -8.1119 } },
  ],
  'Região Autónoma dos Açores': [
    { dico: '4101', name: 'Vila do Porto', center: { lat: 36.9486, lon: -25.145 } },
    { dico: '4201', name: 'Lagoa (Açores)', center: { lat: 37.7447, lon: -25.5719 } },
    { dico: '4202', name: 'Nordeste', center: { lat: 37.8325, lon: -25.1464 } },
    { dico: '4203', name: 'Ponta Delgada', center: { lat: 37.7412, lon: -25.6756 } },
    { dico: '4204', name: 'Povoação', center: { lat: 37.7478, lon: -25.2447 } },
    { dico: '4205', name: 'Ribeira Grande', center: { lat: 37.8219, lon: -25.5197 } },
    { dico: '4206', name: 'Vila Franca do Campo', center: { lat: 37.7169, lon: -25.4328 } },
    { dico: '4301', name: 'Angra do Heroísmo', center: { lat: 38.6558, lon: -27.2189 } },
    { dico: '4302', name: 'Praia da Vitória', center: { lat: 38.7308, lon: -27.0619 } },
    { dico: '4401', name: 'Santa Cruz da Graciosa', center: { lat: 39.0858, lon: -28.0069 } },
    { dico: '4501', name: 'Calheta (Açores)', center: { lat: 38.6019, lon: -28.0156 } },
    { dico: '4502', name: 'Velas', center: { lat: 38.6808, lon: -28.2072 } },
    { dico: '4601', name: 'Lajes do Pico', center: { lat: 38.3992, lon: -28.2528 } },
    { dico: '4602', name: 'Madalena', center: { lat: 38.5342, lon: -28.5269 } },
    { dico: '4603', name: 'São Roque do Pico', center: { lat: 38.5161, lon: -28.3081 } },
    { dico: '4701', name: 'Horta', center: { lat: 38.5364, lon: -28.6294 } },
    { dico: '4801', name: 'Lajes das Flores', center: { lat: 39.3789, lon: -31.1764 } },
    { dico: '4802', name: 'Santa Cruz das Flores', center: { lat: 39.4556, lon: -31.1275 } },
    { dico: '4901', name: 'Corvo', center: { lat: 39.6733, lon: -31.1119 } },
  ],
  'Região Autónoma da Madeira': [
    { dico: '3101', name: 'Calheta (Madeira)', center: { lat: 32.7219, lon: -17.1769 } },
    { dico: '3102', name: 'Câmara de Lobos', center: { lat: 32.6508, lon: -16.9769 } },
    { dico: '3103', name: 'Funchal', center: { lat: 32.6669, lon: -16.9241 } },
    { dico: '3104', name: 'Machico', center: { lat: 32.7186, lon: -16.7669 } },
    { dico: '3105', name: 'Ponta do Sol', center: { lat: 32.6811, lon: -17.1042 } },
    { dico: '3106', name: 'Porto Moniz', center: { lat: 32.8669, lon: -17.1689 } },
    { dico: '3107', name: 'Ribeira Brava', center: { lat: 32.6719, lon: -17.0642 } },
    { dico: '3108', name: 'Santa Cruz', center: { lat: 32.6889, lon: -16.7928 } },
    { dico: '3109', name: 'Santana', center: { lat: 32.8011, lon: -16.8825 } },
    { dico: '3110', name: 'São Vicente', center: { lat: 32.7975, lon: -17.0439 } },
    { dico: '3201', name: 'Porto Santo', center: { lat: 33.0608, lon: -16.3339 } },
  ],
};

// Priority DICOs placed first so seed indices (e.g. MUNICIPALITIES[0] === Sintra) remain invariant
const PRIORITY_SEED_DICOS = [
  '1111', // Sintra
  '1109', // Mafra
  '1508', // Palmela
  '1315', // Valongo
  '1310', // Paredes
  '1009', // Leiria
  '1008', // Figueiró dos Vinhos
  '0603', // Coimbra
  '0101', // Águeda
  '1419', // Tomar
  '1823', // Viseu
  '0508', // Proença-a-Nova
  '0310', // Terras de Bouro
];

function buildAllPortugalMunicipalities(): MunicipalityInfo[] {
  const byDico = new Map<string, MunicipalityInfo>();

  for (const district of PORTUGAL_DISTRICTS) {
    const meta = DISTRICT_CENTERS[district];
    const items = RAW_MUNICIPALITIES_BY_DISTRICT[district] ?? [];
    items.forEach((raw, idx) => {
      const fallbackOffsetLat = ((idx % 5) - 2) * 0.04;
      const fallbackOffsetLon = (Math.floor(idx / 5) - 2) * 0.04;
      const center = raw.center ?? {
        lat: Number((meta.lat + fallbackOffsetLat).toFixed(4)),
        lon: Number((meta.lon + fallbackOffsetLon).toFixed(4)),
      };
      const pir = raw.pir ?? meta.pir;
      byDico.set(raw.dico, {
        dico: raw.dico,
        dicofreDefault: raw.dicofreDefault ?? `${raw.dico}01`,
        name: raw.name,
        district,
        regionGroup: meta.regionGroup,
        defaultCenter: center,
        basePirToday: pir[0],
        basePirTomorrow: pir[1],
        basePirDay2: pir[2],
        isPriorityParishDefault: pir[0] >= 3,
      });
    });
  }

  const ordered: MunicipalityInfo[] = [];
  for (const seedDico of PRIORITY_SEED_DICOS) {
    const found = byDico.get(seedDico);
    if (found) {
      ordered.push(found);
      byDico.delete(seedDico);
    }
  }

  const remaining = Array.from(byDico.values()).sort((a, b) =>
    a.name.localeCompare(b.name, 'pt-PT')
  );
  return [...ordered, ...remaining];
}

export const FULL_PORTUGAL_MUNICIPALITIES: MunicipalityInfo[] = buildAllPortugalMunicipalities();

export function getTotalPortugalParishesCount(): number {
  return Object.values(PORTUGAL_PARISHES_BY_DICO).reduce((sum, list) => sum + list.length, 0);
}

export function getDistrictsList(): string[] {
  return [...PORTUGAL_DISTRICTS];
}

export function resolveMergedMunicipalityCatalog(
  extraMunicipalities?: MunicipalityInfo[]
): MunicipalityInfo[] {
  if (!extraMunicipalities || extraMunicipalities.length === 0) {
    return FULL_PORTUGAL_MUNICIPALITIES;
  }
  const byDico = new Map<string, MunicipalityInfo>();
  for (const m of FULL_PORTUGAL_MUNICIPALITIES) {
    byDico.set(m.dico, m);
  }
  for (const m of extraMunicipalities) {
    if (!byDico.has(m.dico)) {
      byDico.set(m.dico, m);
    } else {
      const existing = byDico.get(m.dico)!;
      byDico.set(m.dico, {
        ...existing,
        ...m,
        district: m.district || existing.district,
      });
    }
  }
  return Array.from(byDico.values());
}

export function findMunicipalityByDico(
  dico: string,
  extraMunicipalities?: MunicipalityInfo[]
): MunicipalityInfo {
  const catalog = resolveMergedMunicipalityCatalog(extraMunicipalities);
  return catalog.find((m) => m.dico === dico) ?? catalog[0];
}

export function getMunicipalitiesByDistrict(
  district: string,
  extraMunicipalities?: MunicipalityInfo[]
): MunicipalityInfo[] {
  const catalog = resolveMergedMunicipalityCatalog(extraMunicipalities);
  const normalized = (district ?? '').trim();
  const matches = catalog.filter((m) => m.district === normalized);
  if (matches.length > 0) {
    return matches.sort((a, b) => a.name.localeCompare(b.name, 'pt-PT'));
  }
  return catalog
    .filter((m) => m.district === PORTUGAL_DISTRICTS[0])
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-PT'));
}

export function getParishesByMunicipality(params: {
  dico: string;
  municipalityName?: string;
  currentParish?: string;
}): string[] {
  const { dico, municipalityName, currentParish } = params;
  const normalizedDico = String(dico ?? '').trim().padStart(4, '0');
  const muni = findMunicipalityByDico(normalizedDico);
  const officialParishes =
    PORTUGAL_PARISHES_BY_DICO[normalizedDico] ??
    PORTUGAL_PARISHES_BY_DICO[muni.dico] ??
    [(municipalityName ?? muni.name).trim() || muni.name];

  const sorted = Array.from(new Set(officialParishes)).sort((a, b) =>
    a.localeCompare(b, 'pt-PT')
  );

  const trimmedCurrent = (currentParish ?? '').trim();
  if (
    trimmedCurrent &&
    trimmedCurrent !== CUSTOM_USER_INPUT_VALUE &&
    !sorted.includes(trimmedCurrent)
  ) {
    return [trimmedCurrent, ...sorted];
  }
  return sorted;
}

function buildMunicipalityShortCode(name: string): string {
  const letters = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z]/g, '')
    .toUpperCase();
  return (letters.slice(0, 3) || 'PRT').padEnd(3, 'X');
}

/**
 * Builds the complete list of Matrix Article (Artigo Matricial) possibilities for the
 * selected municipality & land occupation class, including existing parcel references
 * and the explicit "Input do utilizador" option.
 */
export function buildMatrixArticleOptions(params: {
  landClass: LandClass;
  dico: string;
  municipalityName?: string;
  existingParcels?: ParcelRecord[];
  currentValue?: string;
}): SelectOptionItem[] {
  const { landClass, dico, existingParcels = [], currentValue } = params;

  const existingForMuni = existingParcels
    .filter((p) => p.dico === dico && p.matrixArticle?.trim())
    .map((p) => p.matrixArticle.trim());

  const existingGlobal = existingParcels
    .map((p) => p.matrixArticle?.trim())
    .filter((v): v is string => Boolean(v));

  const classTemplates: string[] =
    landClass === 'AGRICULTURE'
      ? [
          'Rústico — Art.º 204, Secção D (Agrícola / Pomar)',
          'Rústico — Art.º 78, Secção B (Olival / Vinha)',
          'Misto — Art.º 115, Secção C',
          'Rústico — Art.º 142, Secção G',
        ]
      : landClass === 'URBAN_BUILT'
        ? [
            'Urbano — Art.º 1024 (Logradouro / Interface)',
            'Urbano/Rústico — Art.º 311, Secção B',
            'Misto — Art.º 89, Secção C',
            'Urbano — Art.º 518 (Moradia Isolada)',
          ]
        : [
            'Rústico — Art.º 142, Secção G',
            'Rústico — Art.º 204, Secção D',
            'Rústico — Art.º 318, Secção F',
            'Misto — Art.º 89, Secção C',
            'Urbano/Rústico — Art.º 311, Secção B',
          ];

  const generalPossibilities = [
    'Prédio em Herança Indivisa — Matriz Rústica AT',
    'Prédio Omisso na Matriz (Mod. 1 IMI em regularização)',
    'Cadastro Predial Simplificado — Secção Única',
  ];

  const orderedUnique = new Set<string>();
  const trimmedCurrent = (currentValue ?? '').trim();
  if (trimmedCurrent && trimmedCurrent !== CUSTOM_USER_INPUT_VALUE) {
    orderedUnique.add(trimmedCurrent);
  }
  for (const item of existingForMuni) orderedUnique.add(item);
  for (const item of classTemplates) orderedUnique.add(item);
  for (const item of existingGlobal) orderedUnique.add(item);
  for (const item of generalPossibilities) orderedUnique.add(item);

  const options: SelectOptionItem[] = Array.from(orderedUnique).map((val) => ({
    value: val,
    label: val,
  }));

  options.push({
    value: CUSTOM_USER_INPUT_VALUE,
    label: 'Input do utilizador (inserir manualmente)',
  });

  return options;
}

/**
 * Builds the complete list of BUPi (Balcão Único do Prédio) code possibilities for the
 * selected municipality, including existing parcel RGG codes, administrative states,
 * and the explicit "Input do utilizador" option.
 */
export function buildBupiCodeOptions(params: {
  dico: string;
  municipalityName?: string;
  existingParcels?: ParcelRecord[];
  currentValue?: string;
}): SelectOptionItem[] {
  const { dico, municipalityName, existingParcels = [], currentValue } = params;
  const muni = findMunicipalityByDico(dico);
  const code3 = buildMunicipalityShortCode(municipalityName ?? muni.name);

  const existingForMuni = existingParcels
    .filter((p) => p.dico === dico && p.bupiRggId?.trim())
    .map((p) => p.bupiRggId.trim());

  const municipalityTemplates = [
    `RGG-${dico}01-${code3}`,
    `RGG-${dico}42-${code3}`,
    `RGG-884120-${code3}`,
    `BUPI-${dico}-2026-VALIDADO`,
    `BUPI-${dico}-EM-VALIDACAO`,
    `SINERGIC-DGT-${dico}`,
    `ISENTO-MATRIZ-URBANA-${code3}`,
    'SEM-RGG-PENDENTE',
  ];

  const orderedUnique = new Set<string>();
  const trimmedCurrent = (currentValue ?? '').trim();
  if (trimmedCurrent && trimmedCurrent !== CUSTOM_USER_INPUT_VALUE) {
    orderedUnique.add(trimmedCurrent);
  }
  for (const item of existingForMuni) orderedUnique.add(item);
  for (const item of municipalityTemplates) orderedUnique.add(item);

  const options: SelectOptionItem[] = Array.from(orderedUnique).map((val) => ({
    value: val,
    label: val,
  }));

  options.push({
    value: CUSTOM_USER_INPUT_VALUE,
    label: 'Input do utilizador (inserir manualmente)',
  });

  return options;
}

/**
 * Resolves the effective cadastral string from a dropdown selection + custom user input.
 */
export function resolveDropdownOrCustomValue(params: {
  selectedOption: string;
  customInput: string;
  fallbackValue: string;
}): string {
  if (params.selectedOption === CUSTOM_USER_INPUT_VALUE) {
    const trimmed = params.customInput.trim();
    return trimmed || params.fallbackValue;
  }
  return params.selectedOption.trim() || params.fallbackValue;
}
